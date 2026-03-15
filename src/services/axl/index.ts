import type { CucmCredentials } from '../../types/credentials';
import type { ExecuteOperationOptions } from '../../lib/axl-client';
import { getAxlClient } from '../../lib/axl-client';
import { withRetry, isThrottleError } from '../../lib/retry';
import { getAdaptiveDelay, recordOperation } from '../../lib/audit-log';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AxlAPIService {
  async executeOperation(
    credentials: CucmCredentials,
    operation: string,
    tags: unknown,
    opts?: ExecuteOperationOptions
  ): Promise<unknown> {
    // Apply adaptive delay based on recent throttle history
    const adaptiveDelay = getAdaptiveDelay(credentials.host);
    if (adaptiveDelay > 0) {
      console.error(`[AXL Rate] Adaptive delay ${adaptiveDelay}ms for ${credentials.host} (recent throttle events detected)`);
      await delay(adaptiveDelay);
    }

    const startTime = Date.now();

    try {
      const result = await withRetry(
        () => getAxlClient(credentials).executeOperation(operation, tags, opts),
        undefined,
        {
          onRetry: (attempt, error) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            recordOperation(credentials.host, operation, startTime, {
              ok: false,
              throttled: isThrottleError(error),
              error: errMsg,
              attempt,
              request: tags,
            });
          },
        }
      );

      // Count rows if result looks like a list response
      const rows = countResultRows(result);
      recordOperation(credentials.host, operation, startTime, { ok: true, rows, request: tags, response: result });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      recordOperation(credentials.host, operation, startTime, {
        ok: false,
        throttled: isThrottleError(error),
        error: errMsg,
        request: tags,
      });
      throw error;
    }
  }

  async listAll(
    credentials: CucmCredentials,
    operation: string,
    data: Record<string, unknown>,
    opts?: ExecuteOperationOptions,
  ): Promise<{ rows: unknown[]; totalFetched: number; pages: number; truncated: boolean }> {
    const maxRows = parseInt(process.env.AXL_MCP_MAX_AUTOPAGINATE ?? '10000', 10) || 10000;
    const pageSize = 1000;
    const allRows: unknown[] = [];
    let page = 0;
    let truncated = false;

    while (true) {
      const pageData = {
        ...data,
        skip: String(page * pageSize),
        first: String(pageSize),
      };

      const result = await this.executeOperation(credentials, operation, pageData, opts);
      const pageRows = extractRows(result);

      allRows.push(...pageRows);
      page++;

      // Stop if we got fewer rows than requested (last page)
      if (pageRows.length < pageSize) break;

      // Stop if we hit the safety cap
      if (allRows.length >= maxRows) {
        truncated = true;
        break;
      }
    }

    return {
      rows: allRows.slice(0, maxRows),
      totalFetched: Math.min(allRows.length, maxRows),
      pages: page,
      truncated,
    };
  }
}

/**
 * Extract the result array from an AXL list response.
 * AXL responses look like: { return: { phone: [...] } } or { return: { row: [...] } }
 */
function extractRows(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];

  const obj = result as Record<string, unknown>;

  // Check for 'return' wrapper
  const returnVal = obj.return ?? obj;
  if (!returnVal || typeof returnVal !== 'object') return [];

  const inner = returnVal as Record<string, unknown>;

  // Find the first array value
  for (const value of Object.values(inner)) {
    if (Array.isArray(value)) return value;
  }

  // Single result might not be wrapped in array
  for (const value of Object.values(inner)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return [value];
  }

  return [];
}

function countResultRows(result: unknown): number | undefined {
  const rows = extractRows(result);
  return rows.length > 0 ? rows.length : undefined;
}
