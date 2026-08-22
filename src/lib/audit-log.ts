import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emitAxlDiagnostic } from './runtime-diagnostics';
import { AxlPolicyError } from './policy-error';

export interface AuditEntry {
  ts: string;
  operation: string;
  durationMs: number;
  status: 'ok' | 'throttled' | 'error' | 'retry';
  request?: unknown;
  response?: unknown;
  rows?: number;
  error?: string;
  errorCode?: string;
  category?: string;
  attempt?: number;
}

export type AuditLogLevel = 'off' | 'metadata' | 'request' | 'full';

export type RedactionContext =
  | { kind: 'general' }
  | { kind: 'axl-response'; operation: string }
  | { kind: 'audit-entry'; operation: string };

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
    normalized === 'pin' ||
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
  redacted = redacted.replace(/(<((?:[a-z0-9_-]*:)?user)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1***$3');
  redacted = redacted.replace(
    /(<((?:[a-z0-9_-]*:)?[a-z0-9_-]*(?:password|passwd|pwd|passcode|pass|secret|token|authorization|authentication|auth|api[_-]?key|access[_-]?key|secret[_-]?key|username|login|credential|creds)[a-z0-9_-]*)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi,
    '$1***$3'
  );
  redacted = redacted.replace(/(<((?:[a-z0-9_-]+:)?pin)\b[^>]*>)[\s\S]*?(<\/\2\s*>)/gi, '$1***$3');
  redacted = redactQuotedCredentialValues(redacted);
  redacted = redacted.replace(
    /(\b(?:authorization|authentication|auth)\s*[:=]\s*)[^\r\n]*/gi,
    '$1***'
  );
  redacted = redacted.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  redacted = redacted.replace(
    /(\b(?:host|hostname|password|passwd|pwd|passcode|pass|pin|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|username|user|login|credential|creds)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,<]+)/gi,
    '$1***'
  );
  return redacted;
}

function isPlainObjectOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAxlUserResponseWrapper(
  key: string,
  value: unknown,
  path: readonly string[],
  context: RedactionContext
): boolean {
  if (key !== 'user' || !isPlainObjectOrArray(value)) return false;
  if (context.kind === 'general') return false;
  if (context.operation !== 'getUser' && context.operation !== 'listUser') return false;

  if (context.kind === 'axl-response') {
    return path.length === 1 && path[0] === 'return';
  }
  return path.length === 2 && path[0] === 'response' && path[1] === 'return';
}

/** Deep-clone and recursively redact credential keys and credential-like values. */
export function redactCredentials(
  obj: unknown,
  sensitiveValues: readonly string[] = [],
  context: RedactionContext = { kind: 'general' }
): unknown {
  const seen = new WeakSet<object>();

  const redact = (value: unknown, path: readonly string[]): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value, sensitiveValues);
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';

    seen.add(value);
    try {
      if (Array.isArray(value))
        return value.map((item, index) => redact(item, [...path, String(index)]));
      if (value instanceof Date) return value.toISOString();

      const result: Record<string, unknown> = {};
      if (value instanceof Error) {
        result.name = value.name;
        result.message = redactString(value.message, sensitiveValues);
        if (value.stack) result.stack = redactString(value.stack, sensitiveValues);
        if (value.cause !== undefined) result.cause = redact(value.cause, [...path, 'cause']);
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const itemPath = [...path, key];
        result[key] =
          isCredentialKey(key) && !isAxlUserResponseWrapper(key, item, path, context)
            ? '***'
            : redact(item, itemPath);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  };

  return redact(obj, []);
}

export function sanitizeError(error: unknown, sensitiveValues: readonly string[] = []): Error {
  const redacted = redactCredentials(error, sensitiveValues);
  const details =
    redacted && typeof redacted === 'object' ? (redacted as Record<string, unknown>) : {};
  const message =
    typeof details.message === 'string'
      ? details.message
      : redactString(error instanceof Error ? error.message : String(error), sensitiveValues);
  const sanitized =
    error instanceof AxlPolicyError ? new AxlPolicyError(error.code, message) : new Error(message);
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
const MAX_TRACKED_THROTTLE_HOSTS = 64;
const MAX_AUDIT_QUEUE_ENTRIES = 256;
const MAX_AUDIT_QUEUE_BYTES = 1024 * 1024;
const MAX_AUDIT_ENTRY_BYTES = 16 * 1024;

let auditDir: string = DEFAULT_AUDIT_DIR;
const throttleEventsByHost = new Map<string, number[]>();
interface QueuedAuditEntry {
  readonly host: string;
  readonly entry: AuditEntry;
  readonly dir: string;
  readonly byteLength: number;
}
const auditQueue: QueuedAuditEntry[] = [];
let queuedAuditBytes = 0;
let auditProcessing: Promise<void> | undefined;
let auditDropped = 0;
let auditFailures = 0;

export function setAuditDir(dir: string): void {
  auditDir = dir;
  throttleEventsByHost.clear();
}

export function getAuditDir(): string {
  return auditDir;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function auditHostIdentity(host: string): string {
  return createHash('sha256').update(host).digest('hex');
}

/** A stable opaque audit filename that never exposes the configured CUCM host. */
export function auditLogPathForHost(host: string): string {
  return join(auditDir, `cluster-${auditHostIdentity(host)}.jsonl`);
}

export function writeAuditEntry(host: string, entry: AuditEntry): void {
  recordThrottleState(host, entry);
  ensureDir(auditDir);
  const filePath = auditLogPathForHost(host);
  const line =
    JSON.stringify(
      redactCredentials(entry, [], { kind: 'audit-entry', operation: entry.operation })
    ) + '\n';
  appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  rotateIfNeeded(filePath);
}

async function writeAuditEntryAsync(host: string, entry: AuditEntry, dir: string): Promise<void> {
  const filePath = join(dir, `cluster-${auditHostIdentity(host)}.jsonl`);
  const line =
    JSON.stringify(
      redactCredentials(entry, [], { kind: 'audit-entry', operation: entry.operation })
    ) + '\n';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
  await chmod(filePath, 0o600);
  const file = await stat(filePath);
  if (file.size > DEFAULT_MAX_SIZE_BYTES) {
    await rename(filePath, filePath + '.1');
    await chmod(filePath + '.1', 0o600);
  }
}

function queueAuditEntry(host: string, entry: AuditEntry): void {
  recordThrottleState(host, entry);
  const serialized = JSON.stringify(entry);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  const boundedEntry: AuditEntry =
    byteLength <= MAX_AUDIT_ENTRY_BYTES
      ? entry
      : {
          ts: entry.ts,
          operation: entry.operation,
          durationMs: entry.durationMs,
          status: entry.status,
          ...(entry.rows !== undefined && { rows: entry.rows }),
          ...(entry.attempt !== undefined && { attempt: entry.attempt }),
          ...(entry.error && { error: entry.error.slice(0, 1024) }),
          ...(entry.errorCode && { errorCode: entry.errorCode.slice(0, 128) }),
          ...(entry.category && { category: entry.category.slice(0, 128) }),
        };
  const retainedBytes = Math.min(
    Buffer.byteLength(JSON.stringify(boundedEntry), 'utf8'),
    MAX_AUDIT_ENTRY_BYTES
  );
  if (
    auditQueue.length >= MAX_AUDIT_QUEUE_ENTRIES ||
    queuedAuditBytes + retainedBytes > MAX_AUDIT_QUEUE_BYTES
  ) {
    auditDropped = Math.min(auditDropped + 1, MAX_AUDIT_QUEUE_ENTRIES);
    emitAxlDiagnostic('audit_queue_dropped');
    return;
  }
  auditQueue.push({ host, entry: boundedEntry, dir: auditDir, byteLength: retainedBytes });
  queuedAuditBytes += retainedBytes;
  if (!auditProcessing) auditProcessing = drainAuditQueue();
}

async function drainAuditQueue(): Promise<void> {
  while (auditQueue.length > 0) {
    const queued = auditQueue.shift();
    if (!queued) continue;
    queuedAuditBytes -= queued.byteLength;
    try {
      await writeAuditEntryAsync(queued.host, queued.entry, queued.dir);
    } catch {
      auditFailures = Math.min(auditFailures + 1, MAX_AUDIT_QUEUE_ENTRIES);
      emitAxlDiagnostic('audit_write_failed');
    }
  }
  auditProcessing = undefined;
}

/** Flush queued metadata before controlled process shutdown and surface bounded loss. */
export async function flushAuditLog(): Promise<void> {
  await auditProcessing;
  const dropped = auditDropped;
  const failures = auditFailures;
  auditDropped = 0;
  auditFailures = 0;
  if (dropped > 0 || failures > 0) {
    throw new Error(`Audit persistence incomplete: dropped=${dropped}, failures=${failures}`);
  }
}

function recordThrottleState(host: string, entry: AuditEntry): void {
  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  const existing = throttleEventsByHost.get(host) ?? [];
  const recent = existing.filter(timestamp => timestamp >= cutoff);
  if (entry.status === 'throttled') {
    const timestamp = new Date(entry.ts).getTime();
    if (Number.isFinite(timestamp) && timestamp >= cutoff) recent.push(timestamp);
  }
  setThrottleState(host, recent);
}

function setThrottleState(host: string, timestamps: number[]): void {
  throttleEventsByHost.delete(host);
  throttleEventsByHost.set(host, timestamps);
  while (throttleEventsByHost.size > MAX_TRACKED_THROTTLE_HOSTS) {
    const oldestHost = throttleEventsByHost.keys().next().value as string | undefined;
    if (oldestHost === undefined) break;
    throttleEventsByHost.delete(oldestHost);
  }
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
  const cached = throttleEventsByHost.get(host);
  if (cached !== undefined) {
    const cutoff = Date.now() - THROTTLE_WINDOW_MS;
    const recent = cached.filter(timestamp => timestamp >= cutoff);
    setThrottleState(host, recent);
    return recent.length;
  }

  const filePath = auditLogPathForHost(host);
  if (!existsSync(filePath)) return 0;

  const cutoff = Date.now() - THROTTLE_WINDOW_MS;
  const timestamps: number[] = [];
  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        const timestamp = new Date(entry.ts).getTime();
        if (timestamp < cutoff) break;
        if (entry.status === 'throttled') timestamps.push(timestamp);
      } catch {
        // Skip malformed lines without losing later valid audit history.
      }
    }
  } catch {
    return 0;
  }
  setThrottleState(host, timestamps);
  return timestamps.length;
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
    errorCode?: string;
    category?: string;
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
    ...(result.errorCode && { errorCode: result.errorCode }),
    ...(result.category && { category: result.category }),
    ...(result.attempt !== undefined && { attempt: result.attempt }),
  };

  if ((level === 'request' || level === 'full') && result.request !== undefined) {
    entry.request = redactCredentials(result.request, result.sensitiveValues);
  }
  if (level === 'full' && result.response !== undefined) {
    entry.response = redactCredentials(result.response, result.sensitiveValues, {
      kind: 'axl-response',
      operation,
    });
  }

  queueAuditEntry(host, entry);
  return entry;
}
