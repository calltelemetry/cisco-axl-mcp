import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setAuditDir,
  writeAuditEntry,
  getRecentThrottleCount,
  getAdaptiveDelay,
  recordOperation,
  redactCredentials,
  sanitizeError,
  getAuditLogLevel,
  auditLogPathForHost,
  flushAuditLog,
  type AuditEntry,
} from '../src/lib/audit-log';
import { AxlPolicyError } from '../src/lib/policy-error';

let tempDir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-audit-'));
  setAuditDir(tempDir);
  delete process.env.AXL_MCP_AUDIT_LOG;
});

afterEach(async () => {
  await flushAuditLog();
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

function readLogLines(host: string): AuditEntry[] {
  const content = readFileSync(auditLogPathForHost(host), 'utf-8');
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

  it('uses an opaque stable audit path instead of exposing the host', () => {
    const host = 'private-cluster.internal';
    writeAuditEntry(host, {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 1,
      status: 'ok',
    });

    const path = auditLogPathForHost(host);
    expect(path).not.toContain(host);
    expect(path).toBe(auditLogPathForHost(host));
    expect(existsSync(path)).toBe(true);
  });

  it('creates separate files per host', () => {
    writeAuditEntry('host-a', {
      ts: new Date().toISOString(),
      operation: 'addPhone',
      durationMs: 100,
      status: 'ok',
    });
    writeAuditEntry('host-b', {
      ts: new Date().toISOString(),
      operation: 'getUser',
      durationMs: 200,
      status: 'ok',
    });

    const linesA = readLogLines('host-a');
    const linesB = readLogLines('host-b');
    expect(linesA).toHaveLength(1);
    expect(linesA[0]!.operation).toBe('addPhone');
    expect(linesB).toHaveLength(1);
    expect(linesB[0]!.operation).toBe('getUser');
  });

  it('appends multiple entries', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'op1',
      durationMs: 10,
      status: 'ok',
    });
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'op2',
      durationMs: 20,
      status: 'error',
      error: 'fail',
    });

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

  it('creates audit directories and files with owner-only permissions', () => {
    const nestedAuditDir = join(tempDir, 'private', 'audit');
    setAuditDir(nestedAuditDir);

    writeAuditEntry('secure-host', {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 1,
      status: 'ok',
    });

    expect(statSync(nestedAuditDir).mode & 0o777).toBe(0o700);
    expect(statSync(auditLogPathForHost('secure-host')).mode & 0o777).toBe(0o600);
  });

  it('redacts direct audit entries before persistence', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 1,
      status: 'error',
      error: 'SOAP fault: Password=plain-text-secret',
      response: { Authorization: 'Bearer response-token' },
    });

    const persisted = JSON.stringify(readLogLines('host')[0]);
    expect(persisted).not.toContain('plain-text-secret');
    expect(persisted).not.toContain('response-token');
  });

  it('redacts scalar user aliases from direct audit entries', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'getPhone',
      durationMs: 1,
      status: 'error',
      error: 'SOAP fault user=error-user',
      request: { user: 'request-user' },
      response: {
        user: 'response-user',
        nested: { user: 'nested-response-user' },
      },
    });

    const persisted = JSON.stringify(readLogLines('host')[0]);
    for (const secret of ['error-user', 'request-user', 'response-user', 'nested-response-user']) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain('***');
  });
});

describe('recordOperation persistence', () => {
  it('queues operation audit persistence so an AXL request does not synchronously append a file', async () => {
    const host = 'queued-audit-host';
    recordOperation(host, 'getPhone', Date.now(), { ok: true });

    expect(existsSync(auditLogPathForHost(host))).toBe(false);
    await flushAuditLog();
    expect(existsSync(auditLogPathForHost(host))).toBe(true);
  });
});

describe('getRecentThrottleCount', () => {
  it('returns 0 for non-existent host', () => {
    expect(getRecentThrottleCount('no-such-host')).toBe(0);
  });

  it('counts recent throttle events', () => {
    const now = new Date();
    writeAuditEntry('host', {
      ts: now.toISOString(),
      operation: 'op1',
      durationMs: 10,
      status: 'throttled',
      error: 'rate limit',
    });
    writeAuditEntry('host', {
      ts: now.toISOString(),
      operation: 'op2',
      durationMs: 20,
      status: 'ok',
    });
    writeAuditEntry('host', {
      ts: now.toISOString(),
      operation: 'op3',
      durationMs: 30,
      status: 'throttled',
      error: 'rate limit',
    });

    expect(getRecentThrottleCount('host')).toBe(2);
  });

  it('uses operation-time throttle state instead of rereading the audit file on the request path', () => {
    const host = 'in-memory-throttle-host';
    writeAuditEntry(host, {
      ts: new Date().toISOString(),
      operation: 'listPhone',
      durationMs: 1,
      status: 'throttled',
    });
    rmSync(auditLogPathForHost(host));

    expect(getRecentThrottleCount(host)).toBe(1);
  });

  it('bounds in-memory throttle state to avoid retaining every historical host', () => {
    for (let index = 0; index <= 64; index++) {
      writeAuditEntry(`bounded-host-${index}`, {
        ts: new Date().toISOString(),
        operation: 'listPhone',
        durationMs: 1,
        status: 'throttled',
      });
    }
    rmSync(auditLogPathForHost('bounded-host-0'));

    expect(getRecentThrottleCount('bounded-host-0')).toBe(0);
  });

  it('ignores old throttle events outside the 5-minute window', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    const recent = new Date();

    // Write old entry directly to file
    const filePath = auditLogPathForHost('host');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        ts: old.toISOString(),
        operation: 'op1',
        durationMs: 10,
        status: 'throttled',
      }) + '\n'
    );

    // Write recent entry via API
    writeAuditEntry('host', {
      ts: recent.toISOString(),
      operation: 'op2',
      durationMs: 20,
      status: 'throttled',
      error: 'limit',
    });

    expect(getRecentThrottleCount('host')).toBe(1);
  });
});

describe('getAdaptiveDelay', () => {
  it('returns 0 with no throttle events', () => {
    expect(getAdaptiveDelay('clean-host')).toBe(0);
  });

  it('returns 2000ms after 1 throttle', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'op',
      durationMs: 10,
      status: 'throttled',
    });
    expect(getAdaptiveDelay('host')).toBe(2000);
  });

  it('returns 5000ms after 2 throttles', () => {
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'op',
      durationMs: 10,
      status: 'throttled',
    });
    writeAuditEntry('host', {
      ts: new Date().toISOString(),
      operation: 'op',
      durationMs: 10,
      status: 'throttled',
    });
    expect(getAdaptiveDelay('host')).toBe(5000);
  });

  it('returns 10000ms after 3+ throttles', () => {
    for (let i = 0; i < 4; i++) {
      writeAuditEntry('host', {
        ts: new Date().toISOString(),
        operation: 'op',
        durationMs: 10,
        status: 'throttled',
      });
    }
    expect(getAdaptiveDelay('host')).toBe(10000);
  });
});

describe('recordOperation', () => {
  it('records a successful operation', async () => {
    const start = Date.now() - 150;
    const entry = recordOperation('host', 'getPhone', start, { ok: true, rows: 1 });

    expect(entry.status).toBe('ok');
    expect(entry.operation).toBe('getPhone');
    expect(entry.rows).toBe(1);
    expect(entry.durationMs).toBeGreaterThanOrEqual(100);

    await flushAuditLog();
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

  it('defaults to metadata-only records', async () => {
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111', cucm_password: 'secret123', cucm_username: 'admin' },
    });

    await flushAuditLog();
    const lines = readLogLines('host');
    expect(lines[0]!.request).toBeUndefined();
    expect(lines[0]!.response).toBeUndefined();
  });

  it('redacts both request and response when payload logging is explicitly enabled', async () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    recordOperation('host', 'getPhone', Date.now(), {
      ok: false,
      error: 'SOAP fault password=secret123',
      request: { Password: 'secret123' },
      response: { fault: '<Password>secret123</Password>', token: 'response-token' },
      sensitiveValues: ['secret123', 'response-token'],
    });

    await flushAuditLog();
    const persisted = JSON.stringify(readLogLines('host')[0]);
    expect(persisted).not.toContain('secret123');
    expect(persisted).not.toContain('response-token');
    expect(persisted).toContain('***');
  });

  it('retains dispatched-mutation policy classification when an oversized audit entry is compacted', async () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    recordOperation('host', 'updatePhone', Date.now(), {
      ok: false,
      error: 'transport timeout '.repeat(2_000),
      errorCode: 'AXL_MUTATION_OUTCOME_UNKNOWN',
      category: 'AXL_MUTATION_OUTCOME_UNKNOWN',
      request: { payload: 'request-body '.repeat(2_000) },
      response: { payload: 'response-body '.repeat(2_000) },
    });

    await flushAuditLog();

    expect(readLogLines('host')[0]).toMatchObject({
      status: 'error',
      errorCode: 'AXL_MUTATION_OUTCOME_UNKNOWN',
      category: 'AXL_MUTATION_OUTCOME_UNKNOWN',
    });
  });

  it.each(['request', 'full'] as const)(
    'redacts AXL PIN values from %s audit entries while preserving ordinary fields',
    async level => {
      const pin = 'AXL-PIN-AUDIT-731';
      process.env.AXL_MCP_AUDIT_LOG = level;
      recordOperation('host', 'doAuthenticateUser', Date.now(), {
        ok: false,
        error: `SOAP fault pin=${pin} ordinary=error-kept`,
        request: { userid: 'alice', pin, ordinary: 'request-kept' },
        response: {
          fault: `<Fault><pin>${pin}</pin><ordinary>response-kept</ordinary></Fault>`,
        },
      });

      await flushAuditLog();
      const entry = readLogLines('host')[0]!;
      const persisted = JSON.stringify(entry);
      expect(persisted).not.toContain(pin);
      expect(persisted).toContain('request-kept');
      expect(persisted).toContain('error-kept');
      if (level === 'full') expect(persisted).toContain('response-kept');
      else expect(entry.response).toBeUndefined();
    }
  );

  it('includes response at full log level', async () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111' },
      response: { return: { phone: { name: 'SEP111', model: '8845' } } },
    });

    await flushAuditLog();
    const lines = readLogLines('host');
    expect(lines[0]!.request).toEqual({ name: 'SEP111' });
    expect(lines[0]!.response).toEqual({ return: { phone: { name: 'SEP111', model: '8845' } } });
  });

  it.each([
    ['getUser', { userid: 'alice', username: 'directory-login', nested: { user: 'nested-user' } }],
    [
      'listUser',
      [
        { userid: 'alice', password: 'directory-password' },
        { userid: 'bob', nested: { user: 'nested-user' } },
      ],
    ],
  ] as const)(
    'preserves the %s AXL response wrapper in full audit records',
    async (operation, user) => {
      process.env.AXL_MCP_AUDIT_LOG = 'full';
      recordOperation('host', operation, Date.now(), {
        ok: true,
        response: { return: { user } },
      });

      await flushAuditLog();
      const response = readLogLines('host')[0]!.response as {
        return: { user: unknown };
      };
      const persisted = JSON.stringify(response);
      expect(response.return.user).not.toBe('***');
      expect(persisted).toContain('alice');
      expect(persisted).not.toContain('directory-login');
      expect(persisted).not.toContain('directory-password');
      expect(persisted).not.toContain('nested-user');
    }
  );

  it('excludes request at metadata log level', async () => {
    process.env.AXL_MCP_AUDIT_LOG = 'metadata';
    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111' },
      response: { return: { phone: {} } },
    });

    await flushAuditLog();
    const lines = readLogLines('host');
    expect(lines[0]!.request).toBeUndefined();
    expect(lines[0]!.response).toBeUndefined();
  });

  it('writes nothing at off log level', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'off';
    const entry = recordOperation('host', 'getPhone', Date.now(), { ok: true });

    expect(entry.status).toBe('ok');
    const filePath = auditLogPathForHost('host');
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('redactCredentials', () => {
  it('preserves dependency-free policy identity while redacting its message', () => {
    const error = new AxlPolicyError('AXL_REQUEST_CANCELLED', 'cancelled secret-password');

    const sanitized = sanitizeError(error, ['secret-password']);

    expect(sanitized).toBeInstanceOf(AxlPolicyError);
    expect(sanitized).toMatchObject({
      code: 'AXL_REQUEST_CANCELLED',
      message: 'cancelled ***',
    });
  });

  it('redacts scalar user aliases in general objects, arrays, and nested errors', () => {
    const fault = new Error('request failed');
    Object.assign(fault, {
      detail: {
        user: 'error-user',
        nested: [{ user: 'nested-error-user' }],
      },
    });

    const result = redactCredentials({
      user: 'top-level-user',
      nested: { user: 'nested-user' },
      array: [{ user: 'array-user' }],
      fault,
    });
    const serialized = JSON.stringify(result);

    for (const secret of [
      'top-level-user',
      'nested-user',
      'array-user',
      'error-user',
      'nested-error-user',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('***');
  });

  it('redacts scalar user aliases in JSON, escaped JSON, XML, and fault text', () => {
    const redacted = String(
      redactCredentials(
        'SOAP fault {"user":"json-user"} {\\"user\\":\\"escaped-user\\"} <user>xml-user</user> user=fault-user'
      )
    );

    for (const secret of ['json-user', 'escaped-user', 'xml-user', 'fault-user']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('***');
  });

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

  it('redacts authorization values embedded in unstructured strings', () => {
    const redacted = redactCredentials('SOAP fault Authorization: Bearer response-token');
    expect(redacted).not.toContain('response-token');
    expect(redacted).toContain('***');
  });

  it('redacts quoted JSON credential fields embedded in SOAP fault text', () => {
    const redacted = redactCredentials(
      'SOAP fault {"Password":"plain-text-secret","nested":{"Authorization":"Bearer auth-token","api_token":"nested-token"}}'
    );
    const serialized = String(redacted);
    expect(serialized).not.toContain('plain-text-secret');
    expect(serialized).not.toContain('auth-token');
    expect(serialized).not.toContain('nested-token');
    expect(serialized).toContain('***');
  });

  it('redacts escaped quoted JSON and nested XML in error fault details', () => {
    const fault = new Error('SOAP fault {\\"Password\\":\\"message-secret\\"}');
    Object.assign(fault, {
      faultDetail: {
        response: '<Fault><Password>xml-secret</Password></Fault>',
        nested: ['detail {"api_key":"json-token"}'],
      },
    });

    const serialized = JSON.stringify(redactCredentials(fault));
    expect(serialized).not.toContain('message-secret');
    expect(serialized).not.toContain('xml-secret');
    expect(serialized).not.toContain('json-token');
    expect(serialized).toContain('***');
  });

  it('redacts credential XML elements containing nested CDATA', () => {
    const redacted = redactCredentials(
      '<Fault><Password><![CDATA[xml-cdata-secret]]></Password></Fault>'
    );
    expect(redacted).not.toContain('xml-cdata-secret');
    expect(redacted).toContain('***');
  });

  it('redacts auth aliases and numeric credentials in nested and quoted fault data', () => {
    const fault = new Error(
      'SOAP fault {"auth":"json-auth-secret","password":123456,"nested":{"access_key":98765,"token":24680}}'
    );
    Object.assign(fault, {
      detail: {
        auth: 'structured-auth-secret',
        passcode: 112233,
        nested: [
          '<Fault><Auth>xml-auth-secret</Auth><access_key>xml-access-secret</access_key></Fault>',
        ],
      },
    });

    const serialized = JSON.stringify(redactCredentials(fault));
    for (const secret of [
      'json-auth-secret',
      '123456',
      '98765',
      '24680',
      'structured-auth-secret',
      '112233',
      'xml-auth-secret',
      'xml-access-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('***');
  });

  it('redacts arbitrary authorization schemes as a complete header value', () => {
    const redacted = String(
      redactCredentials('SOAP fault\nAuthorization: Token scheme-secret\nFault-Code: 500')
    );

    expect(redacted).not.toContain('Token');
    expect(redacted).not.toContain('scheme-secret');
    expect(redacted).toContain('Authorization: ***');
    expect(redacted).toContain('Fault-Code: 500');
  });

  it.each([
    [
      'comma-bearing Digest',
      'SOAP fault\nAuthorization: Digest username="axl-admin", realm="CUCM", nonce="nonce-secret", response="response-secret"\nFault-Code: 500',
      ['axl-admin', 'CUCM', 'nonce-secret', 'response-secret'],
      'Fault-Code: 500',
    ],
    [
      'semicolon-bearing custom scheme',
      'SOAP fault\r\nAuthorization=Custom first-token; second=second-secret; third=third-secret\r\nTrace-Id: safe-trace',
      ['first-token', 'second-secret', 'third-secret'],
      'Trace-Id: safe-trace',
    ],
  ] as const)(
    'redacts complete %s authorization values in serialized faults',
    (_label, message, secrets, preservedText) => {
      const fault = new Error(message);
      Object.assign(fault, { detail: { faultText: message } });

      const serialized = JSON.stringify(redactCredentials(fault));
      for (const secret of secrets) expect(serialized).not.toContain(secret);
      expect(serialized).toContain('Authorization');
      expect(serialized).toContain('***');
      expect(serialized).toContain(preservedText);
    }
  );

  it('redacts complete delimiter-bearing authorization values from persisted audit errors', async () => {
    recordOperation('host', 'getPhone', Date.now(), {
      ok: false,
      error:
        'SOAP fault\nAuthorization: Digest nonce="audit-nonce", response="audit-response"; next=second-token\nFault-Code: 401',
    });

    await flushAuditLog();
    const persisted = JSON.stringify(readLogLines('host')[0]);
    for (const secret of ['audit-nonce', 'audit-response', 'second-token']) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain('Authorization: ***');
    expect(persisted).toContain('Fault-Code: 401');
  });

  it('redacts case variants, credential-like values, URLs, XML faults, errors, and arrays recursively', () => {
    const fault = new Error(
      'POST https://admin:secret123@cucm.example.test/axl?token=response-token failed: <Password>secret123</Password>'
    );
    Object.assign(fault, {
      detail: {
        PASSWORD: 'secret123',
        nested: [{ api_key: 'response-token' }, { Authorization: 'Bearer response-token' }],
      },
    });

    const redacted = redactCredentials(fault, ['admin', 'secret123', 'response-token']);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('secret123');
    expect(serialized).not.toContain('response-token');
    expect(serialized).toContain('***');
  });

  it('redacts AXL PINs from structured, JSON, XML, fault-text, and explicit-value paths', () => {
    const secrets = {
      structured: 'AXL-PIN-STRUCTURED-731',
      json: 'AXL-PIN-JSON-731',
      escapedJson: 'AXL-PIN-ESCAPED-731',
      xml: 'AXL-PIN-XML-731',
      text: 'AXL-PIN-TEXT-731',
      explicit: 'AXL-PIN-EXPLICIT-731',
    };
    const redacted = redactCredentials(
      {
        pin: secrets.structured,
        ordinary: 'structured-kept',
        fault:
          `SOAP fault {"pin":"${secrets.json}"} ` +
          `{\\"PIN\\":\\"${secrets.escapedJson}\\"} ` +
          `<Fault><axl:pin>${secrets.xml}</axl:pin><ordinary>xml-kept</ordinary></Fault> ` +
          `PIN=${secrets.text} ordinary=text-kept ` +
          `opaque=${secrets.explicit}`,
      },
      [secrets.explicit]
    );
    const serialized = JSON.stringify(redacted);

    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
    for (const ordinary of ['structured-kept', 'xml-kept', 'text-kept']) {
      expect(serialized).toContain(ordinary);
    }
    expect(serialized).toContain('***');
  });
});

describe('getAuditLogLevel', () => {
  it('defaults to metadata', () => {
    delete process.env.AXL_MCP_AUDIT_LOG;
    expect(getAuditLogLevel()).toBe('metadata');
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

  it.each(['request', 'req', 'true', '1'])(
    'returns request for explicit value or legacy alias %s',
    value => {
      process.env.AXL_MCP_AUDIT_LOG = value;
      expect(getAuditLogLevel()).toBe('request');
    }
  );

  it.each(['', '   ', 'typo', 'verbose', 'payload'])(
    'fails closed to metadata for invalid value %j',
    value => {
      process.env.AXL_MCP_AUDIT_LOG = value;
      expect(getAuditLogLevel()).toBe('metadata');
    }
  );

  it('does not persist request payload for an invalid configured audit level', async () => {
    process.env.AXL_MCP_AUDIT_LOG = 'typo';

    recordOperation('host', 'getPhone', Date.now(), {
      ok: true,
      request: { name: 'SEP111', password: 'must-not-be-logged' },
    });

    await flushAuditLog();
    const persisted = JSON.stringify(readLogLines('host')[0]);
    expect(persisted).not.toContain('SEP111');
    expect(persisted).not.toContain('must-not-be-logged');
    expect(readLogLines('host')[0]!.request).toBeUndefined();
  });

  it('returns full', () => {
    process.env.AXL_MCP_AUDIT_LOG = 'full';
    expect(getAuditLogLevel()).toBe('full');
    process.env.AXL_MCP_AUDIT_LOG = 'all';
    expect(getAuditLogLevel()).toBe('full');
  });
});
