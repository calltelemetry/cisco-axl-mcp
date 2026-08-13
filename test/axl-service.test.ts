import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CiscoAxlService from 'cisco-axl';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAuditDir, writeAuditEntry } from '../src/lib/audit-log';

// Mock getAxlClient to avoid real CUCM connections
vi.mock('../src/lib/axl-client', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/axl-client')>();
  const mockClient = {
    executeOperation: vi.fn().mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } }),
  };
  return {
    ...actual,
    getAxlClient: vi.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

import { AxlAPIService, STRICT_AXL_EXECUTION_POLICY } from '../src/services/axl/index';
import { runCli } from '../src/cli';
import { handleTool } from '../src/tools/index';
const { __mockClient: mockClient, getAxlClient: mockGetAxlClient } =
  (await import('../src/lib/axl-client')) as any;

const creds = { host: 'test-host', username: 'admin', password: 'pass', version: '14.0' };
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-svc-'));
  setAuditDir(tempDir);
  vi.clearAllMocks();
  mockClient.executeOperation.mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AxlAPIService.executeOperation', () => {
  it('passes the configured TLS mode through the service boundary', async () => {
    const ServiceWithTlsConstructor = AxlAPIService as unknown as new (
      tlsMode: 'secure' | 'insecure'
    ) => AxlAPIService;
    const service = new ServiceWithTlsConstructor('insecure');

    await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });

    expect(mockGetAxlClient).toHaveBeenCalledWith(creds, 'insecure');
  });

  it('calls getAxlClient and returns result', async () => {
    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    expect(result).toEqual({ return: { phone: [{ name: 'SEP111' }] } });
    expect(mockClient.executeOperation).toHaveBeenCalledWith(
      'getPhone',
      { name: 'SEP111' },
      undefined
    );
  });

  it('records successful operation to audit log', async () => {
    const service = new AxlAPIService();
    await service.executeOperation(creds, 'listPhone', { searchCriteria: { name: '%' } });

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.operation).toBe('listPhone');
    expect(last.status).toBe('ok');
    expect(last.rows).toBe(1);
  });

  it('records failed operation to audit log and rethrows', async () => {
    mockClient.executeOperation.mockRejectedValue(new Error('401 Unauthorized'));

    const service = new AxlAPIService();
    await expect(service.executeOperation(creds, 'getPhone', { name: 'X' })).rejects.toThrow(
      '401 Unauthorized'
    );

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));

    const last = entries[entries.length - 1];
    expect(last.status).toBe('error');
    expect(last.error).toContain('401');
  });

  it('records throttle events correctly', async () => {
    const origRetries = process.env.AXL_MCP_MAX_RETRIES;
    const origDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';

    mockClient.executeOperation.mockRejectedValue(
      new Error('Maximum AXL Memory Allocation Consumed')
    );

    const service = new AxlAPIService();
    await expect(service.executeOperation(creds, 'listPhone', {})).rejects.toThrow('Memory');

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));

    const throttled = entries.filter((e: { status: string }) => e.status === 'throttled');
    expect(throttled.length).toBeGreaterThanOrEqual(1);

    process.env.AXL_MCP_MAX_RETRIES = origRetries;
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = origDelay;
  });

  it('keeps retryable CLI service failures out of raw console output', async () => {
    const secret = 'RETRY-SERVICE-SECRET-731';
    const controls = '\r\n\u001b\u0085\u009b\u2028\u2029';
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    const originalAuditLevel = process.env.AXL_MCP_AUDIT_LOG;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    process.env.AXL_MCP_AUDIT_LOG = 'metadata';
    mockClient.executeOperation.mockRejectedValue(
      new Error(`503 retry for ${secret}${controls} ordinary tail`)
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let stdout = '';
    let stderr = '';

    try {
      expect(
        await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], {
          env: {
            CUCM_HOST: creds.host,
            CUCM_USERNAME: creds.username,
            CUCM_PASSWORD: secret,
            CUCM_VERSION: '15.0',
          },
          stdout: { write: value => ((stdout += String(value)), true) },
          stderr: { write: value => ((stderr += String(value)), true) },
          readStdin: async () => '',
          runnerDependencies: { service: new AxlAPIService() },
        })
      ).toBe(4);

      const consoleOutput = consoleSpy.mock.calls.flat().join(' ');
      for (const output of [stdout, stderr, consoleOutput]) {
        expect(output).not.toContain(secret);
        for (const control of ['\r', '\u001b', '\u0085', '\u009b', '\u2028', '\u2029']) {
          expect(output).not.toContain(control);
        }
      }
      expect(stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({
        error: { code: 'CLI_AXL_FAILURE', message: expect.stringContaining('503') },
      });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);

      const { readFileSync } = await import('node:fs');
      const content = readFileSync(join(tempDir, `${creds.host}.jsonl`), 'utf-8');
      expect(content).not.toContain(secret);
      expect(content).toContain('"status":"retry"');
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      if (originalAuditLevel === undefined) delete process.env.AXL_MCP_AUDIT_LOG;
      else process.env.AXL_MCP_AUDIT_LOG = originalAuditLevel;
      consoleSpy.mockRestore();
    }
  }, 15_000);

  it('does not retry a retryable mutation and classifies its outcome as unknown', async () => {
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '3';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    mockClient.executeOperation.mockRejectedValue(new Error('503 Service Unavailable'));
    let stdout = '';
    let stderr = '';

    try {
      expect(
        await runCli(
          [
            'execute',
            'updatePhone',
            '--data',
            '{"name":"SEP111","description":"new description"}',
            '--write',
            '--confirm',
            'updatePhone',
          ],
          {
            env: {
              CUCM_HOST: creds.host,
              CUCM_USERNAME: creds.username,
              CUCM_PASSWORD: creds.password,
              CUCM_VERSION: '15.0',
            },
            stdout: { write: value => ((stdout += String(value)), true) },
            stderr: { write: value => ((stderr += String(value)), true) },
            readStdin: async () => '',
            runnerDependencies: { service: new AxlAPIService() },
          }
        )
      ).toBe(5);
      expect(JSON.parse(stdout)).toMatchObject({
        error: {
          code: 'AXL_MUTATION_OUTCOME_UNKNOWN',
          message: expect.stringContaining('reconciliation'),
        },
      });
      expect(stderr).toContain('AXL_MUTATION_OUTCOME_UNKNOWN');
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
    }
  });

  it('preserves legacy retry and original error behavior for direct MCP mutations', async () => {
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    const originalEnabledObjects = process.env.AXL_MCP_ENABLED_OBJECTS;
    const originalConfig = process.env.AXL_MCP_CONFIG;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    mockClient.executeOperation.mockRejectedValue(new Error('503 Service Unavailable'));

    try {
      const failure = await handleTool(
        'axl_execute',
        {
          cucm_host: creds.host,
          cucm_username: creds.username,
          cucm_password: creds.password,
          cucm_version: '15.0',
          operation: 'updatePhone',
          data: { name: 'SEP111', description: 'legacy MCP mutation' },
        },
        new AxlAPIService()
      ).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        message: expect.stringContaining('503 Service Unavailable'),
      });
      expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      if (originalEnabledObjects === undefined) delete process.env.AXL_MCP_ENABLED_OBJECTS;
      else process.env.AXL_MCP_ENABLED_OBJECTS = originalEnabledObjects;
      if (originalConfig === undefined) delete process.env.AXL_MCP_CONFIG;
      else process.env.AXL_MCP_CONFIG = originalConfig;
    }
  });

  it.each([
    ['ECONNRESET code', Object.assign(new Error('request failed'), { code: 'ECONNRESET' })],
    [
      'nested ETIMEDOUT cause',
      new Error('request failed', {
        cause: Object.assign(new Error('connection stalled'), { code: 'ETIMEDOUT' }),
      }),
    ],
    [
      'nested EPIPE errno',
      new Error('request failed', {
        cause: Object.assign(new Error('socket write failed'), { errno: 'EPIPE' }),
      }),
    ],
    ['ENOTFOUND code', Object.assign(new Error('request failed'), { code: 'ENOTFOUND' })],
    ['generic network code', Object.assign(new Error('request failed'), { code: 'ERR_NETWORK' })],
    ['structured 503 status', Object.assign(new Error('request failed'), { statusCode: 503 })],
  ])(
    'classifies a mutating %s failure as outcome unknown after one transport attempt',
    async (_label, transportError) => {
      mockClient.executeOperation.mockRejectedValue(transportError);

      const failure = await new AxlAPIService()
        .executeOperation(
          { ...creds, version: '15.0' },
          'updatePhone',
          {
            name: 'SEP111',
            description: 'new',
          },
          undefined,
          'secure',
          STRICT_AXL_EXECUTION_POLICY
        )
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves a structured SOAP business fault for a mutation without inviting a retry', async () => {
    const fault = Object.assign(new Error('AXL validation failed after upstream status 503'), {
      response: { statusCode: 503 },
      fault: { faultcode: 'soap:Client', faultstring: 'Invalid field value' },
    });
    mockClient.executeOperation.mockRejectedValue(fault);

    const failure = await new AxlAPIService()
      .executeOperation({ ...creds, version: '15.0' }, 'updatePhone', {
        name: 'SEP111',
        description: 'new',
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: 'AXL validation failed after upstream status 503' });
    expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
    expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
  });

  it.each(['CUCM business limit 429', 'CUCM business state 503'])(
    'preserves real cisco-axl AXLOperationError %s for a mutation',
    async message => {
      const fault = new CiscoAxlService.AXLOperationError(message, 'updatePhone');
      mockClient.executeOperation.mockRejectedValue(fault);

      const failure = await new AxlAPIService()
        .executeOperation({ ...creds, version: '15.0' }, 'updatePhone', {
          name: 'SEP111',
          description: 'new',
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ name: 'AXLOperationError', message });
      expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['CUCM business limit 429', 'CUCM business state 503'])(
    'does not retry real cisco-axl AXLOperationError %s for a read',
    async message => {
      const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
      const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      process.env.AXL_MCP_MAX_RETRIES = '1';
      process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
      mockClient.executeOperation.mockRejectedValue(
        new CiscoAxlService.AXLOperationError(message, 'getPhone')
      );

      try {
        const failure = await new AxlAPIService()
          .executeOperation({ ...creds, version: '15.0' }, 'getPhone', { name: 'SEP111' })
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({ name: 'AXLOperationError', message });
        expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
        expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
      } finally {
        if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
        else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
        if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
        else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      }
    }
  );

  it('retries a real cisco-axl memory-allocation fault for a read', async () => {
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    mockClient.executeOperation.mockRejectedValue(
      new CiscoAxlService.AXLOperationError('Maximum AXL Memory Allocation Consumed', 'listPhone')
    );

    try {
      const failure = await new AxlAPIService()
        .executeOperation({ ...creds, version: '15.0' }, 'listPhone', {
          searchCriteria: { name: '%' },
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        name: 'AXLOperationError',
        message: 'Maximum AXL Memory Allocation Consumed',
      });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
    }
  });

  it.each([
    ['12.0', 'getAuthzKey'],
    ['12.0', 'listAuthzKeys'],
    ['15.0', 'getPhone'],
    ['15.0', 'listPhone'],
    ['15.0', 'executeSQLQueryInactive'],
  ] as const)(
    'retries selected-version read %s %s for a nested transport code',
    async (version, operation) => {
      const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
      const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      process.env.AXL_MCP_MAX_RETRIES = '1';
      process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
      const transportError = new Error('request failed', {
        cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
      });
      mockClient.executeOperation.mockRejectedValue(transportError);

      try {
        const failure = await new AxlAPIService()
          .executeOperation({ ...creds, version }, operation, {})
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({ message: 'request failed' });
        expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
        expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);
      } finally {
        if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
        else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
        if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
        else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      }
    }
  );

  it('classifies an operation unsupported by the selected version conservatively as a mutation', async () => {
    mockClient.executeOperation.mockRejectedValue(
      Object.assign(new Error('request failed'), { code: 'ECONNRESET' })
    );

    const failure = await new AxlAPIService()
      .executeOperation(
        { ...creds, version: '15.0' },
        'getAuthzKey',
        {},
        undefined,
        'secure',
        STRICT_AXL_EXECUTION_POLICY
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
    expect(mockClient.executeOperation).toHaveBeenCalledTimes(1);
  });

  it.each(['12.5', '14.0', '15.0'])(
    'retries executeSQLQueryInactive as a CUCM %s read and preserves the transport failure',
    async version => {
      const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
      const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      process.env.AXL_MCP_MAX_RETRIES = '1';
      process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
      mockClient.executeOperation.mockRejectedValue(new Error('503 Service Unavailable'));

      try {
        const service = new AxlAPIService();
        const failure = await service
          .executeOperation({ ...creds, version }, 'executeSQLQueryInactive', {
            sql: 'select name from device',
          })
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({ message: '503 Service Unavailable' });
        expect(failure).not.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
        expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);
      } finally {
        if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
        else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
        if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
        else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      }
    }
  );

  it('applies adaptive delay when recent throttle events exist', async () => {
    // Seed audit log with a recent throttle event
    writeAuditEntry(creds.host, {
      ts: new Date().toISOString(),
      operation: 'listPhone',
      durationMs: 500,
      status: 'throttled',
      error: 'rate limit',
    });

    // Mock the delay function by using fake timers
    vi.useFakeTimers();

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new AxlAPIService();
    const promise = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });

    // Advance past adaptive delay (2000ms for 1 throttle event)
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    vi.useRealTimers();

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('records rows count for list results', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: { phone: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    });

    const service = new AxlAPIService();
    await service.executeOperation(creds, 'listPhone', {});

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBe(3);
  });

  it('handles results with no rows (non-list)', async () => {
    mockClient.executeOperation.mockResolvedValue({ return: 'ok' });

    const service = new AxlAPIService();
    await service.executeOperation(creds, 'addPhone', { phone: {} });

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBeUndefined();
  });

  it('redacts credential fields in responses returned to MCP callers', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: {
        phone: {
          name: 'SEP111',
          Password: 'response-password',
          nested: [{ api_token: 'response-token' }],
        },
      },
    });

    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('response-password');
    expect(serialized).not.toContain('response-token');
    expect(serialized).toContain('SEP111');
  });

  it('preserves a getUser domain object while redacting its credential fields', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: {
        user: {
          userid: 'alice',
          firstName: 'Alice',
          lastName: 'Example',
          username: 'directory-login',
          password: 'directory-password',
          nested: { authToken: 'directory-token', user: 'nested-user-credential' },
        },
      },
    });

    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getUser', { userid: 'alice' });

    expect(result).toEqual({
      return: {
        user: {
          userid: 'alice',
          firstName: 'Alice',
          lastName: 'Example',
          username: '***',
          password: '***',
          nested: { authToken: '***', user: '***' },
        },
      },
    });
  });

  it.each([
    ['getUser', { return: { user: 'scalar-user-credential' } }],
    ['listUser', { return: { user: 123456 } }],
    ['getPhone', { return: { user: { userid: 'non-axl-user-object' } } }],
  ] as const)(
    'redacts user values without the getUser/listUser wrapper shape for %s',
    async (operation, response) => {
      mockClient.executeOperation.mockResolvedValue(response);

      const service = new AxlAPIService();
      const result = await service.executeOperation(creds, operation, {});

      expect(result).toEqual({ return: { user: '***' } });
    }
  );

  it('handles single object result (not wrapped in array)', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: { phone: { name: 'SEP111', model: 'Cisco 8845' } },
    });

    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    expect(result).toBeDefined();

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBe(1); // single object counted as 1 row
  });
});

describe('AxlAPIService.listAll (integrated)', () => {
  it('paginates through real executeOperation', async () => {
    let callCount = 0;
    mockClient.executeOperation.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { return: { phone: Array.from({ length: 1000 }, (_, i) => ({ name: `P${i}` })) } };
      }
      return {
        return: { phone: Array.from({ length: 50 }, (_, i) => ({ name: `P${1000 + i}` })) },
      };
    });

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', { searchCriteria: { name: '%' } });

    expect(result.rows).toHaveLength(1050);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('handles empty response from CUCM', async () => {
    mockClient.executeOperation.mockResolvedValue({});

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', {});

    expect(result.rows).toHaveLength(0);
    expect(result.pages).toBe(1);
  });

  it('handles null/primitive return values', async () => {
    mockClient.executeOperation.mockResolvedValue(null);

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', {});

    expect(result.rows).toHaveLength(0);
  });

  it('paginates listUser rows without redacting the user response wrapper', async () => {
    let callCount = 0;
    mockClient.executeOperation.mockImplementation(async () => {
      callCount++;
      const offset = callCount === 1 ? 0 : 1000;
      const count = callCount === 1 ? 1000 : 1;
      return {
        return: {
          user: Array.from({ length: count }, (_, index) => ({
            userid: `user-${offset + index}`,
            displayName: `User ${offset + index}`,
            username: `login-${offset + index}`,
            password: `password-${offset + index}`,
            auth: { token: `token-${offset + index}` },
            nested: { user: `credential-user-${offset + index}` },
          })),
        },
      };
    });

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listUser', {
      searchCriteria: { userid: '%' },
    });

    expect(result.rows).toHaveLength(1001);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows[0]).toEqual({
      userid: 'user-0',
      displayName: 'User 0',
      username: '***',
      password: '***',
      auth: '***',
      nested: { user: '***' },
    });
    expect(result.rows[1000]).toMatchObject({ userid: 'user-1000', displayName: 'User 1000' });
    expect(JSON.stringify(result.rows)).not.toContain('password-');
    expect(JSON.stringify(result.rows)).not.toContain('token-');
    expect(JSON.stringify(result.rows)).not.toContain('credential-user-');
  });
});
