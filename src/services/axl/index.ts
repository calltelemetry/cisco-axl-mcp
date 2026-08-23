import type { CucmCredentials } from '../../types/credentials';
import type {
  AxlClientCacheOptions,
  AxlClientLease,
  AxlRequestLifecycle,
  ExecuteOperationOptions,
  TlsMode,
} from '../../lib/axl-client';
import { acquireAxlClientLease } from '../../lib/axl-client';
import { emitAxlDiagnostic } from '../../lib/runtime-diagnostics';
import { isRetryable, isThrottleError } from '../../lib/retry';
import { isMutationOperationForVersion } from '../../lib/operation-classification-core';
import { AxlPolicyError } from '../../types/axl/errors';
import type { ResolvedMcpConfig } from '../../lib/tool-config';
import {
  getAdaptiveDelay,
  recordOperation,
  redactCredentials,
  sanitizeError,
} from '../../lib/audit-log';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_CACHE_MAX_ENTRIES = 16;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_AUTOPAGINATE = 10_000;

export interface AxlServiceOptions {
  readonly tlsMode: TlsMode;
  readonly requestTimeoutMs: number;
  readonly clientCacheMaxEntries: number;
  /** Optional policy overrides; omitted values are resolved once at construction. */
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxAutoPaginate?: number;
  readonly clock?: MonotonicClock;
}

interface ResolvedAxlServiceOptions {
  readonly tlsMode: TlsMode;
  readonly requestTimeoutMs: number;
  readonly clientCacheMaxEntries: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxAutoPaginate: number;
  readonly clock?: MonotonicClock;
}

export interface MonotonicClock {
  now(): number;
}

interface ExecutionDeadline {
  readonly expiresAt: number;
  dispatched: boolean;
}

const monotonicClock: MonotonicClock = { now: () => performance.now() };

function parseEnvironmentInteger(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  fallback: number
): number {
  return parseInt(environment[name] ?? String(fallback), 10) || fallback;
}

function defaultServiceOptions(
  tlsMode: TlsMode = 'secure',
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): ResolvedAxlServiceOptions {
  return {
    tlsMode,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    clientCacheMaxEntries: DEFAULT_CLIENT_CACHE_MAX_ENTRIES,
    maxRetries: parseEnvironmentInteger(environment, 'AXL_MCP_MAX_RETRIES', DEFAULT_MAX_RETRIES),
    retryBaseDelayMs: parseEnvironmentInteger(
      environment,
      'AXL_MCP_RETRY_BASE_DELAY_MS',
      DEFAULT_RETRY_BASE_DELAY_MS
    ),
    maxAutoPaginate: parseEnvironmentInteger(
      environment,
      'AXL_MCP_MAX_AUTOPAGINATE',
      DEFAULT_MAX_AUTOPAGINATE
    ),
  };
}

function resolveServiceOptions(
  options:
    | TlsMode
    | AxlServiceOptions
    | Pick<ResolvedMcpConfig, 'tlsMode' | 'requestTimeoutMs' | 'clientCacheMaxEntries'> = 'secure',
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): ResolvedAxlServiceOptions {
  if (typeof options === 'string') return defaultServiceOptions(options, environment);
  const defaults = defaultServiceOptions(options.tlsMode, environment);
  return {
    tlsMode: options.tlsMode,
    requestTimeoutMs: options.requestTimeoutMs,
    clientCacheMaxEntries: options.clientCacheMaxEntries,
    maxRetries: (options as AxlServiceOptions).maxRetries ?? defaults.maxRetries,
    retryBaseDelayMs: (options as AxlServiceOptions).retryBaseDelayMs ?? defaults.retryBaseDelayMs,
    maxAutoPaginate: (options as AxlServiceOptions).maxAutoPaginate ?? defaults.maxAutoPaginate,
    clock: (options as AxlServiceOptions).clock,
  };
}

/** Resolve service policy from an immutable startup environment snapshot. */
export function resolveAxlServiceOptions(
  options: Pick<ResolvedMcpConfig, 'tlsMode' | 'requestTimeoutMs' | 'clientCacheMaxEntries'>,
  environment: Readonly<NodeJS.ProcessEnv>
): AxlServiceOptions {
  return Object.freeze(resolveServiceOptions(options, environment));
}

function requestTimeoutError(dispatched: boolean): AxlPolicyError {
  if (!dispatched) return notDispatchedTimeoutError();
  return new AxlPolicyError(
    'AXL_READ_TIMEOUT',
    'AXL read timed out before the configured deadline'
  );
}

function notDispatchedTimeoutError(): AxlPolicyError {
  return new AxlPolicyError(
    'AXL_REQUEST_TIMEOUT_NOT_DISPATCHED',
    'AXL request deadline elapsed before the operation was dispatched'
  );
}

function requestCancelledError(): AxlPolicyError {
  return new AxlPolicyError('AXL_REQUEST_CANCELLED', 'AXL request was cancelled before completion');
}

function remainingMs(deadline: ExecutionDeadline, clock: MonotonicClock): number {
  return Math.max(0, deadline.expiresAt - clock.now());
}

async function delayWithinDeadline(
  delayMs: number,
  deadline: ExecutionDeadline,
  clock: MonotonicClock,
  signal?: AbortSignal
): Promise<void> {
  const remaining = remainingMs(deadline, clock);
  if (remaining <= 0) throw requestTimeoutError(deadline.dispatched);
  const waitMs = Math.min(delayMs, remaining);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timerRef: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timerRef.timer) clearTimeout(timerRef.timer);
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => finish(() => reject(requestCancelledError()));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timerRef.timer = setTimeout(() => {
      if (delayMs >= remaining) finish(() => reject(requestTimeoutError(deadline.dispatched)));
      else finish(resolve);
    }, waitMs);
  });
}

function executeWithinDeadline<T>(
  operation: (lifecycle: AxlRequestLifecycle) => Promise<T>,
  deadline: ExecutionDeadline,
  clock: MonotonicClock,
  shutdownSignal?: AbortSignal
): Promise<T> {
  const remaining = remainingMs(deadline, clock);
  if (remaining <= 0) return Promise.reject(requestTimeoutError(deadline.dispatched));

  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const timeoutRef: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (complete: () => void) => {
      if (settled) return false;
      settled = true;
      if (timeoutRef.timer) clearTimeout(timeoutRef.timer);
      shutdownSignal?.removeEventListener('abort', abortFromShutdown);
      complete();
      return true;
    };
    const abortFromShutdown = () => {
      if (!finish(() => reject(requestCancelledError()))) return;
      controller.abort();
    };
    shutdownSignal?.addEventListener('abort', abortFromShutdown, { once: true });
    const lifecycle: AxlRequestLifecycle = {
      timeoutMs: Math.max(1, Math.ceil(remaining)),
      signal: controller.signal,
      remainingTimeoutMs: () => Math.max(0, Math.ceil(remainingMs(deadline, clock))),
      markDispatched: () => {
        deadline.dispatched = true;
      },
    };
    timeoutRef.timer = setTimeout(() => {
      if (!finish(() => reject(requestTimeoutError(deadline.dispatched)))) return;
      controller.abort();
    }, remaining);

    if (shutdownSignal?.aborted) {
      abortFromShutdown();
      return;
    }

    Promise.resolve()
      .then(() => operation(lifecycle))
      .then(
        value => {
          finish(() => resolve(value));
        },
        error => {
          finish(() => reject(error));
        }
      );
  });
}

export interface AxlServiceExecutionPolicy {
  readonly mutationRetryMode: 'strict';
  /** Request-local cancellation propagated from the MCP server shutdown path. */
  readonly shutdownSignal?: AbortSignal;
}

export const STRICT_AXL_EXECUTION_POLICY: AxlServiceExecutionPolicy = Object.freeze({
  mutationRetryMode: 'strict',
});

export class AxlAPIService {
  private readonly options: ResolvedAxlServiceOptions;
  private readonly clock: MonotonicClock;

  constructor(
    options:
      | TlsMode
      | AxlServiceOptions
      | Pick<ResolvedMcpConfig, 'tlsMode' | 'requestTimeoutMs' | 'clientCacheMaxEntries'> = 'secure'
  ) {
    this.options = Object.freeze(resolveServiceOptions(options));
    this.clock = this.options.clock ?? monotonicClock;
  }

  async executeOperation(
    credentials: CucmCredentials,
    operation: string,
    tags: unknown,
    opts?: ExecuteOperationOptions,
    tlsMode: TlsMode = this.options.tlsMode,
    executionPolicy?: AxlServiceExecutionPolicy,
    shutdownSignal?: AbortSignal
  ): Promise<unknown> {
    const effectiveShutdownSignal = shutdownSignal ?? executionPolicy?.shutdownSignal;
    return this.executeOperationWithinDeadline(
      credentials,
      operation,
      tags,
      opts,
      tlsMode,
      executionPolicy,
      { expiresAt: this.clock.now() + this.options.requestTimeoutMs, dispatched: false },
      effectiveShutdownSignal
    );
  }

  private async executeOperationWithinDeadline(
    credentials: CucmCredentials,
    operation: string,
    tags: unknown,
    opts: ExecuteOperationOptions | undefined,
    tlsMode: TlsMode,
    executionPolicy: AxlServiceExecutionPolicy | undefined,
    deadline: ExecutionDeadline,
    shutdownSignal?: AbortSignal,
    admittedLease?: AxlClientLease
  ): Promise<unknown> {
    const startTime = Date.now();
    const mutationOperation = isMutationOperationForVersion(operation, credentials.version);
    const strictMutation = executionPolicy?.mutationRetryMode === 'strict' && mutationOperation;
    const cacheOptions: AxlClientCacheOptions = {
      ...(this.options.clientCacheMaxEntries === DEFAULT_CLIENT_CACHE_MAX_ENTRIES
        ? {}
        : { maxEntries: this.options.clientCacheMaxEntries }),
      onDiagnostic: event => emitAxlDiagnostic(`axl_client_cache_${event}`),
    };

    let lease = admittedLease;
    let ownsLease = false;
    try {
      if (!lease) {
        lease = acquireAxlClientLease(credentials, tlsMode, cacheOptions);
        ownsLease = true;
      }
      const activeLease = lease;
      const dispatch = (lifecycle: AxlRequestLifecycle) =>
        activeLease.client.executeOperation(operation, tags, opts, lifecycle);

      // Apply adaptive delay based on recent throttle history within the same deadline.
      const adaptiveDelay = getAdaptiveDelay(credentials.host);
      if (adaptiveDelay > 0) {
        await delayWithinDeadline(adaptiveDelay, deadline, this.clock, shutdownSignal);
      }
      const maxRetries = strictMutation ? 0 : this.options.maxRetries;
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await executeWithinDeadline(dispatch, deadline, this.clock, shutdownSignal);
          break;
        } catch (error) {
          if (error instanceof AxlPolicyError) throw error;
          if (attempt >= maxRetries || !isRetryable(error)) throw error;

          const retryAttempt = attempt + 1;
          const errMsg = error instanceof Error ? error.message : String(error);
          recordOperation(credentials.host, operation, startTime, {
            ok: false,
            throttled: isThrottleError(error),
            error: errMsg,
            attempt: retryAttempt,
            request: tags,
            sensitiveValues: [credentials.password, credentials.username, credentials.host],
          });
          const retryDelay = Math.min(this.options.retryBaseDelayMs * Math.pow(2, attempt), 30_000);
          await delayWithinDeadline(retryDelay, deadline, this.clock, shutdownSignal);
        }
      }

      // Count rows if result looks like a list response
      const rows = countResultRows(result);
      const safeResult = redactCredentials(
        result,
        [credentials.password, credentials.username, credentials.host],
        {
          kind: 'axl-response',
          operation,
        }
      );
      recordOperation(credentials.host, operation, startTime, {
        ok: true,
        rows,
        request: tags,
        response: safeResult,
        sensitiveValues: [credentials.password, credentials.username, credentials.host],
      });

      return safeResult;
    } catch (error) {
      let finalError = error;
      if (
        mutationOperation &&
        error instanceof AxlPolicyError &&
        (error.code === 'AXL_READ_TIMEOUT' || error.code === 'AXL_REQUEST_CANCELLED') &&
        deadline.dispatched
      ) {
        finalError = new AxlPolicyError(
          'AXL_MUTATION_OUTCOME_UNKNOWN',
          'Mutation outcome is unknown after the request deadline elapsed post-dispatch; reconciliation/readback is required before another attempt'
        );
      } else if (strictMutation && isRetryable(error)) {
        finalError = new AxlPolicyError(
          'AXL_MUTATION_OUTCOME_UNKNOWN',
          'Mutation outcome is unknown after a retryable transport failure; reconciliation/readback is required before another attempt'
        );
      }
      if (
        finalError instanceof AxlPolicyError &&
        finalError.code.startsWith('AXL_') &&
        (finalError.code.includes('TIMEOUT') || finalError.code.includes('OUTCOME_UNKNOWN'))
      ) {
        emitAxlDiagnostic(`axl_timeout_${finalError.code.toLowerCase().replace('axl_', '')}`);
      }
      const errMsg = finalError instanceof Error ? finalError.message : String(finalError);
      const policyCode = finalError instanceof AxlPolicyError ? finalError.code : undefined;
      recordOperation(credentials.host, operation, startTime, {
        ok: false,
        throttled: isThrottleError(error),
        error: errMsg,
        request: tags,
        sensitiveValues: [credentials.password, credentials.username, credentials.host],
        ...(policyCode && { errorCode: policyCode, category: policyCode }),
      });
      throw sanitizeError(finalError, [
        credentials.password,
        credentials.username,
        credentials.host,
      ]);
    } finally {
      if (ownsLease) lease?.release();
    }
  }

  async listAll(
    credentials: CucmCredentials,
    operation: string,
    data: Record<string, unknown>,
    opts?: ExecuteOperationOptions,
    tlsMode: TlsMode = this.options.tlsMode,
    executionPolicy?: AxlServiceExecutionPolicy,
    shutdownSignal?: AbortSignal
  ): Promise<{ rows: unknown[]; totalFetched: number; pages: number; truncated: boolean }> {
    const effectiveShutdownSignal = shutdownSignal ?? executionPolicy?.shutdownSignal;
    const deadline: ExecutionDeadline = {
      expiresAt: this.clock.now() + this.options.requestTimeoutMs,
      dispatched: false,
    };
    const maxRows = this.options.maxAutoPaginate;
    const pageSize = 1000;
    const allRows: unknown[] = [];
    let page = 0;
    let truncated = false;
    const usesCustomExecuteOperation =
      this.executeOperation !== AxlAPIService.prototype.executeOperation;
    const lease = usesCustomExecuteOperation
      ? undefined
      : acquireAxlClientLease(credentials, tlsMode, {
          ...(this.options.clientCacheMaxEntries === DEFAULT_CLIENT_CACHE_MAX_ENTRIES
            ? {}
            : { maxEntries: this.options.clientCacheMaxEntries }),
          onDiagnostic: event => emitAxlDiagnostic(`axl_client_cache_${event}`),
        });

    try {
      while (true) {
        const pageData = {
          ...data,
          skip: String(page * pageSize),
          first: String(pageSize),
        };

        const result = usesCustomExecuteOperation
          ? await this.executeOperation(
              credentials,
              operation,
              pageData,
              opts,
              tlsMode,
              executionPolicy,
              effectiveShutdownSignal
            )
          : await this.executeOperationWithinDeadline(
              credentials,
              operation,
              pageData,
              opts,
              tlsMode,
              executionPolicy,
              deadline,
              effectiveShutdownSignal,
              lease
            );
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
    } finally {
      lease?.release();
    }
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
