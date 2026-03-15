import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AuditEntry {
  ts: string;
  operation: string;
  durationMs: number;
  status: 'ok' | 'throttled' | 'error' | 'retry';
  request?: unknown;
  response?: unknown;
  rows?: number;
  error?: string;
  attempt?: number;
}

export type AuditLogLevel = 'off' | 'metadata' | 'request' | 'full';

/**
 * Determine audit log level from environment.
 *
 * AXL_MCP_AUDIT_LOG controls what gets logged:
 *   - "off"      — no audit logging
 *   - "metadata" — operation, status, duration, rows (no payloads)
 *   - "request"  — metadata + request payload with redacted credentials (default)
 *   - "full"     — metadata + request + response payloads
 */
export function getAuditLogLevel(): AuditLogLevel {
  const val = (process.env.AXL_MCP_AUDIT_LOG ?? 'request').toLowerCase().trim();
  if (val === 'off' || val === 'false' || val === '0' || val === 'none') return 'off';
  if (val === 'metadata' || val === 'meta') return 'metadata';
  if (val === 'full' || val === 'all') return 'full';
  return 'request'; // default
}

const CREDENTIAL_KEYS = new Set([
  'cucm_password', 'cucm_username', 'password', 'username',
  'cucm_host', 'host',
]);

/**
 * Deep-clone an object and redact credential fields.
 */
export function redactCredentials(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactCredentials);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key) && typeof value === 'string') {
      result[key] = '***';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactCredentials(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const DEFAULT_AUDIT_DIR = join(homedir(), '.cisco-axl-mcp', 'audit');
const DEFAULT_MAX_SIZE_BYTES = (parseInt(process.env.AXL_MCP_AUDIT_MAX_SIZE_MB ?? '10', 10) || 10) * 1024 * 1024;
const THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

let auditDir: string = DEFAULT_AUDIT_DIR;

export function setAuditDir(dir: string): void {
  auditDir = dir;
}

export function getAuditDir(): string {
  return auditDir;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function hostFilePath(host: string): string {
  // Sanitize host for filename (replace colons for IPv6, etc.)
  const safe = host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  return join(auditDir, `${safe}.jsonl`);
}

export function writeAuditEntry(host: string, entry: AuditEntry): void {
  ensureDir(auditDir);
  const filePath = hostFilePath(host);
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(filePath, line, 'utf-8');
  rotateIfNeeded(filePath);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stats = statSync(filePath);
    if (stats.size > DEFAULT_MAX_SIZE_BYTES) {
      renameSync(filePath, filePath + '.1');
    }
  } catch {
    // File may not exist yet or stat failed — ignore
  }
}

export function getRecentThrottleCount(host: string): number {
  const filePath = hostFilePath(host);
  if (!existsSync(filePath)) return 0;

  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  let count = 0;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Read from the end for efficiency — recent entries are at the bottom
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line) as AuditEntry;
        const entryTime = new Date(entry.ts).getTime();

        // Stop scanning once we're past the window
        if (entryTime < cutoff) break;

        if (entry.status === 'throttled') count++;
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error — return 0
  }

  return count;
}

/**
 * Calculate adaptive delay based on recent throttle events.
 * Returns milliseconds to wait before making the next call.
 *
 * 0 throttles in last 5 min → 0ms delay
 * 1 throttle → 2000ms
 * 2 throttles → 5000ms
 * 3+ throttles → 10000ms
 */
export function getAdaptiveDelay(host: string): number {
  const count = getRecentThrottleCount(host);
  if (count === 0) return 0;
  if (count === 1) return 2000;
  if (count === 2) return 5000;
  return 10000;
}

/**
 * Record an AXL operation result to the audit log and return the entry.
 */
export function recordOperation(
  host: string,
  operation: string,
  startTime: number,
  result: {
    ok: boolean;
    throttled?: boolean;
    error?: string;
    rows?: number;
    attempt?: number;
    request?: unknown;
    response?: unknown;
  }
): AuditEntry {
  const level = getAuditLogLevel();
  if (level === 'off') {
    // Still return the entry shape for callers, just don't write
    return {
      ts: new Date().toISOString(),
      operation,
      durationMs: Date.now() - startTime,
      status: result.throttled ? 'throttled' : result.ok ? 'ok' : result.attempt ? 'retry' : 'error',
    };
  }

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    operation,
    durationMs: Date.now() - startTime,
    status: result.throttled ? 'throttled' : result.ok ? 'ok' : result.attempt ? 'retry' : 'error',
    ...(result.rows !== undefined && { rows: result.rows }),
    ...(result.error && { error: result.error }),
    ...(result.attempt !== undefined && { attempt: result.attempt }),
  };

  // Include request payload (redacted) at 'request' or 'full' level
  if ((level === 'request' || level === 'full') && result.request !== undefined) {
    entry.request = redactCredentials(result.request);
  }

  // Include response payload only at 'full' level
  if (level === 'full' && result.response !== undefined) {
    entry.response = result.response;
  }

  writeAuditEntry(host, entry);
  return entry;
}
