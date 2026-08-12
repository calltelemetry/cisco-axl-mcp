import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
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

/** Metadata-only is the safe default; payload logging must be explicitly enabled. */
export function getAuditLogLevel(): AuditLogLevel {
  const val = (process.env.AXL_MCP_AUDIT_LOG ?? 'metadata').toLowerCase().trim();
  if (val === 'off' || val === 'false' || val === '0' || val === 'none') return 'off';
  if (val === 'metadata' || val === 'meta') return 'metadata';
  if (val === 'request' || val === 'req' || val === 'true' || val === '1') return 'request';
  if (val === 'full' || val === 'all') return 'full';
  return 'metadata';
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'host' ||
    normalized.endsWith('host') ||
    normalized === 'user' ||
    normalized.endsWith('username') ||
    normalized === 'login' ||
    normalized === 'auth' ||
    normalized.endsWith('auth') ||
    normalized.includes('authentication') ||
    normalized.includes('password') ||
    normalized.endsWith('passwd') ||
    normalized.endsWith('pwd') ||
    normalized === 'pass' ||
    normalized.includes('passcode') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('authorization') ||
    normalized.includes('apikey') ||
    normalized.includes('accesskey') ||
    normalized.includes('secretkey') ||
    normalized === 'creds' ||
    normalized.includes('credential')
  );
}

function decodeJsonKey(key: string): string {
  try {
    return JSON.parse(`"${key}"`) as string;
  } catch {
    return key;
  }
}

function redactQuotedCredentialValues(value: string): string {
  const escaped = value.replace(
    /(\\"((?:\\\\.|[^"\\])*)\\"\s*:\s*)(?:\\"(?:\\\\.|[^"\\])*\\"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g,
    (match, prefix: string, key: string) =>
      isCredentialKey(decodeJsonKey(key)) ? `${prefix}\\"***\\"` : match
  );
  return escaped.replace(
    /("((?:\\.|[^"\\])*)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g,
    (match, prefix: string, key: string) =>
      isCredentialKey(decodeJsonKey(key)) ? `${prefix}"***"` : match
  );
}

function redactString(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const secret of sensitiveValues) {
    if (secret) redacted = redacted.split(secret).join('***');
  }

  redacted = redacted.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1***:***@');
  redacted = redacted.replace(
    /(<((?:[a-z0-9_-]*:)?[a-z0-9_-]*(?:password|passwd|pwd|passcode|pass|secret|token|authorization|authentication|auth|api[_-]?key|access[_-]?key|secret[_-]?key|username|login|credential|creds)[a-z0-9_-]*)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi,
    '$1***$3'
  );
  redacted = redactQuotedCredentialValues(redacted);
  redacted = redacted.replace(
    /(\b(?:authorization|authentication|auth)\s*[:=]\s*)[^\r\n]*/gi,
    '$1***'
  );
  redacted = redacted.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  redacted = redacted.replace(
    /(\b(?:password|passwd|pwd|passcode|pass|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|username|login|credential|creds)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,<]+)/gi,
    '$1***'
  );
  return redacted;
}

/** Deep-clone and recursively redact credential keys and credential-like values. */
export function redactCredentials(obj: unknown, sensitiveValues: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();

  const redact = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value, sensitiveValues);
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';

    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(redact);
      if (value instanceof Date) return value.toISOString();

      const result: Record<string, unknown> = {};
      if (value instanceof Error) {
        result.name = value.name;
        result.message = redactString(value.message, sensitiveValues);
        if (value.stack) result.stack = redactString(value.stack, sensitiveValues);
        if (value.cause !== undefined) result.cause = redact(value.cause);
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = isCredentialKey(key) ? '***' : redact(item);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  };

  return redact(obj);
}

export function sanitizeError(error: unknown, sensitiveValues: readonly string[] = []): Error {
  const redacted = redactCredentials(error, sensitiveValues);
  const details =
    redacted && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : {};
  const message =
    typeof details.message === 'string'
      ? details.message
      : redactString(error instanceof Error ? error.message : String(error), sensitiveValues);
  const sanitized = new Error(message);
  sanitized.name =
    typeof details.name === 'string' ? details.name : error instanceof Error ? error.name : 'Error';
  if (typeof details.stack === 'string') sanitized.stack = details.stack;
  for (const [key, value] of Object.entries(details)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack') {
      (sanitized as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return sanitized;
}

const DEFAULT_AUDIT_DIR = join(homedir(), '.cisco-axl-mcp', 'audit');
const DEFAULT_MAX_SIZE_BYTES =
  (parseInt(process.env.AXL_MCP_AUDIT_MAX_SIZE_MB ?? '10', 10) || 10) * 1024 * 1024;
const THROTTLE_WINDOW_MS = 5 * 60 * 1000;

let auditDir: string = DEFAULT_AUDIT_DIR;

export function setAuditDir(dir: string): void {
  auditDir = dir;
}

export function getAuditDir(): string {
  return auditDir;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function hostFilePath(host: string): string {
  const safe = host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  return join(auditDir, `${safe}.jsonl`);
}

export function writeAuditEntry(host: string, entry: AuditEntry): void {
  ensureDir(auditDir);
  const filePath = hostFilePath(host);
  const line = JSON.stringify(redactCredentials(entry)) + '\n';
  appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  rotateIfNeeded(filePath);
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (statSync(filePath).size > DEFAULT_MAX_SIZE_BYTES) {
      renameSync(filePath, filePath + '.1');
      chmodSync(filePath + '.1', 0o600);
    }
  } catch {
    // Audit persistence must not replace an operation result with a rotation failure.
  }
}

export function getRecentThrottleCount(host: string): number {
  const filePath = hostFilePath(host);
  if (!existsSync(filePath)) return 0;

  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  let count = 0;
  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (new Date(entry.ts).getTime() < cutoff) break;
        if (entry.status === 'throttled') count++;
      } catch {
        // Skip malformed lines without losing later valid audit history.
      }
    }
  } catch {
    return 0;
  }
  return count;
}

export function getAdaptiveDelay(host: string): number {
  const count = getRecentThrottleCount(host);
  if (count === 0) return 0;
  if (count === 1) return 2000;
  if (count === 2) return 5000;
  return 10000;
}

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
    sensitiveValues?: string[];
  }
): AuditEntry {
  const level = getAuditLogLevel();
  const status = result.throttled
    ? 'throttled'
    : result.ok
      ? 'ok'
      : result.attempt
        ? 'retry'
        : 'error';
  if (level === 'off') {
    return { ts: new Date().toISOString(), operation, durationMs: Date.now() - startTime, status };
  }

  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    operation,
    durationMs: Date.now() - startTime,
    status,
    ...(result.rows !== undefined && { rows: result.rows }),
    ...(result.error && { error: redactString(result.error, result.sensitiveValues ?? []) }),
    ...(result.attempt !== undefined && { attempt: result.attempt }),
  };

  if ((level === 'request' || level === 'full') && result.request !== undefined) {
    entry.request = redactCredentials(result.request, result.sensitiveValues);
  }
  if (level === 'full' && result.response !== undefined) {
    entry.response = redactCredentials(result.response, result.sensitiveValues);
  }

  writeAuditEntry(host, entry);
  return entry;
}
