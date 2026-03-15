import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setAuditDir,
  writeAuditEntry,
  getRecentThrottleCount,
  getAdaptiveDelay,
  recordOperation,
  redactCredentials,
  getAuditLogLevel,
  type AuditEntry,
} from '../src/lib/audit-log';

let tempDir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-audit-'));
  setAuditDir(tempDir);
  delete process.env.AXL_MCP_AUDIT_LOG;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function readLogLines(host: string): AuditEntry[] {
  const safe = host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditEntry);
}

describe('writeAuditEntry', () => {
  it('writes a JSONL entry for a host', () => {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 150,
      status: 'ok',
    };
    writeAuditEntry('10.1.1.100', entry);

    const lines = readLogLines('10.1.1.100');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.operation).toBe('getPhone');
    expect(lines[0]!.status).toBe('ok');
  });

  it('creates separate files per host', () => {
    writeAuditEntry('host-a', { ts: new Date().toISOString(), operation: 'addPhone', durationMs: 100, status: 'ok' });
    writeAuditEntry('host-b', { ts: new Date().toISOString(), operation: 'getUser', durationMs: 200, status: 'ok' });

    const linesA = readLogLines('host-a');
    const linesB = readLogLines('host-b');
    expect(linesA).toHaveLength(1);
    expect(linesA[0]!.operation).toBe('addPhone');
    expect(linesB).toHaveLength(1);
    expect(linesB[0]!.operation).toBe('getUser');
  });

  it('appends multiple entries', () => {
    writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op1', durationMs: 10, status: 'ok' });
    writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op2', durationMs: 20, status: 'error', error: 'fail' });

    const lines = readLogLines('host');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.error).toBe('fail');
  });

  it('includes optional fields when present', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'listPhone',
      durationMs: 500,
      status: 'ok',
      rows: 42,
    });
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 100,
      status: 'retry',
      attempt: 2,
      error: 'timeout',
    });

    const lines = readLogLines('host');
    expect(lines[0]!.rows).toBe(42);
    expect(lines[1]!.attempt).toBe(2);
    expect(lines[1]!.error).toBe('timeout');
  });
});

describe('getRecentThrottleCount', () => {
  it('returns 0 for non-existent host', () => {
    expect(getRecentThrottleCount('no-such-host')).toBe(0);
  });

  it('counts recent throttle events', () => {
    const now = new Date();
    writeAuditEntry('host', { ts: now.toISOString(), operation: 'op1', durationMs: 10, status: 'throttled', error: 'rate limit' });
    writeAuditEntry('host', { ts: now.toISOString(), operation: 'op2', durationMs: 20, status: 'ok' });
    writeAuditEntry('host', { ts: now.toISOString(), operation: 'op3', durationMs: 30, status: 'throttled', error: 'rate limit' });

    expect(getRecentThrottleCount('host')).toBe(2);
  });

  it('ignores old throttle events outside the 5-minute window', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    const recent = new Date();

    // Write old entry directly to file
    const safe = 'host';
    const filePath = join(tempDir, `${safe}.jsonl`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ ts: old.toISOString(), operation: 'op1', durationMs: 10, status: 'throttled' }) + '\n');

    // Write recent entry via API
    writeAuditEntry('host', { ts: recent.toISOString(), operation: 'op2', durationMs: 20, status: 'throttled', error: 'limit' });

    expect(getRecentThrottleCount('host')).toBe(1);
  });
});

describe('getAdaptiveDelay', () => {
  it('returns 0 with no throttle events', () => {
    expect(getAdaptiveDelay('clean-host')).toBe(0);
  });

  it('returns 2000ms after 1 throttle', () => {
    writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op', durationMs: 10, status: 'throttled' });
    expect(getAdaptiveDelay('host')).toBe(2000);
  });

  it('returns 5000ms after 2 throttles', () => {
    writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op', durationMs: 10, status: 'throttled' });
    writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op', durationMs: 10, status: 'throttled' });
    expect(getAdaptiveDelay('host')).toBe(5000);
  });

  it('returns 10000ms after 3+ throttles', () => {
    for (let i = 0; i < 4; i++) {
      writeAuditEntry('host', { ts: new Date().toISOString(), operation: 'op', durationMs: 10, status: 'throttled' });
    }
    expect(getAdaptiveDelay('host')).toBe(10000);
  });
});

describe('recordOperation', () => {
  it('records a successful operation', () => {
    const start = Date.now() - 150;
    const entry = recordOperation('host', 'getPhone', start, { ok: true, rows: 1 });

    expect(entry.status).toBe('ok');
    expect(entry.operation).toBe('getPhone');
    expect(entry.rows).toBe(1);
    expect(entry.durationMs).toBeGreaterThanOrEqual(100);

    const lines = readLogLines('host');
    expect(lines).toHaveLength(1);
  });

  it('records a throttled operation', () => {
    const entry = recordOperation('host', 'listPhone', Date.now(), {
      ok: false,
      throttled: true,
      error: 'Maximum AXL Memory Allocation Consumed',
    });
    expect(entry.status).toBe('throttled');
    expect(entry.error).toContain('Memory');
  });

  it('records a retry attempt', () => {
    const entry = recordOperation('host', 'addPhone', Date.now(), {
      ok: false,
      error: 'ECONNRESET',
      attempt: 2,
    });
    expect(entry.status).toBe('retry');
    expect(entry.attempt).toBe(2);
  });

  it('records a plain error', () => {
    const entry = recordOperation('host', 'getUser', Date.now(), {
      ok: false,
      error: 'Not found',
    });
    expect(entry.status).toBe('error');
  });

  it('includes redacted request at default log level', () => {
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111', cucm_password: 'secret123', cucm_username: 'admin' },
    });

    const lines = readLogLines('host');
    expect(lines[0]!.request).toEqual({ name: 'SEP111', cucm_password: '***', cucm_username: '***' });
    expect(lines[0]!.response).toBeUndefined();
  });

  it('includes response at full log level', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111' },
      response: { return: { phone: { name: 'SEP111', model: '8845' } } },
    });

    const lines = readLogLines('host');
    expect(lines[0]!.request).toEqual({ name: 'SEP111' });
    expect(lines[0]!.response).toEqual({ return: { phone: { name: 'SEP111', model: '8845' } } });
  });

  it('excludes request at metadata log level', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'metadata';
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111' },
      response: { return: { phone: {} } },
    });

    const lines = readLogLines('host');
    expect(lines[0]!.request).toBeUndefined();
    expect(lines[0]!.response).toBeUndefined();
  });

  it('writes nothing at off log level', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'off';
    const entry = recordOperation('host', 'getPhone', Date.now(), { ok: true });

    expect(entry.status).toBe('ok');
    const safe = 'host';
    const filePath = join(tempDir, `${safe}.jsonl`);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('redactCredentials', () => {
  it('redacts password and username fields', () => {
    const result = redactCredentials({
      cucm_password: 'secret',
      cucm_username: 'admin',
      cucm_host: '10.1.1.1',
      name: 'SEP111',
    });
    expect(result).toEqual({
      cucm_password: '***',
      cucm_username: '***',
      cucm_host: '***',
      name: 'SEP111',
    });
  });

  it('redacts nested credential fields', () => {
    const result = redactCredentials({
      outer: { password: 'secret', data: 'keep' },
    });
    expect(result).toEqual({
      outer: { password: '***', data: 'keep' },
    });
  });

  it('handles arrays', () => {
    const result = redactCredentials([{ password: 'x' }, { name: 'y' }]);
    expect(result).toEqual([{ password: '***' }, { name: 'y' }]);
  });

  it('handles null and primitives', () => {
    expect(redactCredentials(null)).toBe(null);
    expect(redactCredentials(undefined)).toBe(undefined);
    expect(redactCredentials('hello')).toBe('hello');
    expect(redactCredentials(42)).toBe(42);
  });
});

describe('getAuditLogLevel', () => {
  it('defaults to request', () => {
    delete process.env.AXL_MCP_AUDIT_LOG;
    expect(getAuditLogLevel()).toBe('request');
  });

  it('returns off for false/0/none/off', () => {
    for (const val of ['off', 'false', '0', 'none']) {
      process.env.AXL_MCP_AUDIT_LOG = val;
      expect(getAuditLogLevel()).toBe('off');
    }
  });

  it('returns metadata', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'metadata';
    expect(getAuditLogLevel()).toBe('metadata');
    process.env.AXL_MCP_AUDIT_LOG = 'meta';
    expect(getAuditLogLevel()).toBe('metadata');
  });

  it('returns full', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    expect(getAuditLogLevel()).toBe('full');
    process.env.AXL_MCP_AUDIT_LOG = 'all';
    expect(getAuditLogLevel()).toBe('full');
  });
});
