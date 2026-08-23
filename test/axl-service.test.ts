import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import CiscoAxlService from 'cisco-axl';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  auditLogPathForHost,
  flushAuditLog,
  setAuditDir,
  writeAuditEntry,
} from '../src/lib/audit-log';

// Mock getAxlClient to avoid real CUCM connections
vi.mock('../src/lib/axl-client', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/axl-client')>();
  const mockClient = {
    executeOperation: vi.fn().mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } }),
  };
  const getAxlClient = vi.fn(
    (_credentials?: unknown, _tlsMode?: unknown, _cacheOptions?: unknown) => mockClient
  );
  const acquireAxlClientLease = vi.fn(
    (credentials: unknown, tlsMode: unknown, cacheOptions: unknown) => ({
      client: getAxlClient(credentials, tlsMode, cacheOptions),
      release: vi.fn(),
    })
  );
  return {
    ...actual,
    getAxlClient,
    acquireAxlClientLease,
    __mockClient: mockClient,
    __acquireAxlClientLease: acquireAxlClientLease,
  };
});

import { AxlAPIService, STRICT_AXL_EXECUTION_POLICY } from '../src/services/axl/index';
import { runCli } from '../src/cli';
import { AXL_RUNNER_PACKAGE_VERSION, runAxl } from '../src/lib/axl-runner';
import { createMutationGrant, MutationGrantReplayStore } from '../src/lib/mutation-grants';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';
const { __mockClient: mockClient, getAxlClient: mockGetAxlClient } =
  (await import('../src/lib/axl-client')) as any;
const { __acquireAxlClientLease: mockAcquireAxlClientLease } =
  (await import('../src/lib/axl-client')) as any;

const creds = { host: 'test-host', username: 'admin', password: 'pass', version: '14.0' };
let tempDir: string;

beforeAll(async () => {
  await loadAxlVersionArtifacts('14.0');
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-svc-'));
  setAuditDir(tempDir);
  vi.clearAllMocks();
  mockClient.executeOperation.mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } });
});

afterEach(async () => {
  await flushAuditLog();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AxlAPIService.executeOperation', () => {
  it('snapshots retry policy at service construction', async () => {
    vi.useFakeTimers();
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    let calls = 0;
    mockClient.executeOperation.mockImplementation(() => {
      calls += 1;
      return calls === 4
        ? Promise.resolve({ return: { phone: [{ name: 'SEP111' }] } })
        : Promise.reject(new Error('503 Service Unavailable'));
    });

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 1_000,
        clientCacheMaxEntries: 2,
      });
      process.env.AXL_MCP_MAX_RETRIES = '3';

      const outcome = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
      const observed = outcome.then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error })
      );
      await vi.advanceTimersByTimeAsync(20);
      await expect(observed).resolves.toMatchObject({
        status: 'rejected',
        error: { message: '503 Service Unavailable' },
      });
      expect(calls).toBe(2);
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      vi.useRealTimers();
    }
  });

  it('passes the configured TLS mode through the service boundary', async () => {
    const ServiceWithTlsConstructor = AxlAPIService as unknown as new (
      tlsMode: 'secure' | 'insecure'
    ) => AxlAPIService;
    const service = new ServiceWithTlsConstructor('insecure');

    await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });

    expect(mockGetAxlClient).toHaveBeenCalledWith(
      creds,
      'insecure',
      expect.objectContaining({ onDiagnostic: expect.any(Function) })
    );
  });

  it('acquires one generation lease across every bounded retry and releases it once', async () => {
    let calls = 0;
    const release = vi.fn();
    mockAcquireAxlClientLease.mockReturnValue({ client: mockClient, release });
    mockClient.executeOperation.mockImplementation(() => {
      calls++;
      return calls === 2
        ? Promise.resolve({ return: { phone: [{ name: 'SEP111' }] } })
        : Promise.reject(new Error('503 Service Unavailable'));
    });
    const providerCredentials = { ...creds, credentialGeneration: 4 };
    const service = new AxlAPIService({
      tlsMode: 'secure',
      requestTimeoutMs: 1_000,
      clientCacheMaxEntries: 2,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });

    await expect(
      service.executeOperation(providerCredentials, 'getPhone', { name: 'SEP111' })
    ).resolves.toEqual({ return: { phone: [{ name: 'SEP111' }] } });
    expect(mockAcquireAxlClientLease).toHaveBeenCalledOnce();
    expect(mockAcquireAxlClientLease).toHaveBeenCalledWith(
      providerCredentials,
      'secure',
      expect.objectContaining({ onDiagnostic: expect.any(Function) })
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('passes remaining deadline budget, cancellation signal, and dispatch callback to the client', async () => {
    const dispatchMarked = vi.fn();
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: { markDispatched(): void }
      ) => {
        lifecycle.markDispatched();
        dispatchMarked();
        return Promise.resolve({ return: { phone: [{ name: 'SEP111' }] } });
      }
    );

    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    expect(result).toEqual({ return: { phone: [{ name: 'SEP111' }] } });
    const [operation, tags, options, lifecycle] = mockClient.executeOperation.mock.calls[0] as [
      string,
      Record<string, unknown>,
      undefined,
      { timeoutMs: number; signal: AbortSignal; markDispatched(): void },
    ];
    expect(operation).toBe('getPhone');
    expect(tags).toEqual({ name: 'SEP111' });
    expect(options).toBeUndefined();
    expect(lifecycle.timeoutMs).toBeGreaterThan(0);
    expect(lifecycle.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(lifecycle.signal).toBeInstanceOf(AbortSignal);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(dispatchMarked).toHaveBeenCalledOnce();
  });

  it('classifies a read that exceeds its one end-to-end deadline without retrying it', async () => {
    vi.useFakeTimers();
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: { markDispatched(): void }
      ) => {
        lifecycle.markDispatched();
        return new Promise(resolve => setTimeout(() => resolve({ return: { phone: [] } }), 20));
      }
    );

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
      });
      const pending = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(20);

      await expect(outcome).resolves.toMatchObject({ code: 'AXL_READ_TIMEOUT' });
      expect(mockClient.executeOperation).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never extends a read deadline across retry backoff', async () => {
    vi.useFakeTimers();
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '3';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '8';
    mockClient.executeOperation.mockRejectedValue(new Error('503 Service Unavailable'));
    const startedAt = Date.now();

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
      });
      const pending = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      await expect(outcome).resolves.toMatchObject({ code: 'AXL_REQUEST_TIMEOUT_NOT_DISPATCHED' });
      expect(mockClient.executeOperation).toHaveBeenCalledTimes(2);
      expect(Date.now() - startedAt).toBe(10);
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
      vi.useRealTimers();
    }
  });

  it('audits a timeout that expires during adaptive delay before dispatch', async () => {
    vi.useFakeTimers();
    writeAuditEntry(creds.host, {
      ts: new Date().toISOString(),
      operation: 'listPhone',
      durationMs: 1,
      status: 'throttled',
    });

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
      });
      const pending = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toMatchObject({ code: 'AXL_REQUEST_TIMEOUT_NOT_DISPATCHED' });
      await flushAuditLog();

      const entries = (await import('node:fs'))
        .readFileSync(auditLogPathForHost(creds.host), 'utf-8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({ operation: 'getPhone', status: 'error' });
      expect(entries[1].error).toContain('AXL request deadline elapsed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a queued ten-second adaptive delay without dispatching or leaving late audit work', async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 3; index++) {
      writeAuditEntry(creds.host, {
        ts: new Date().toISOString(),
        operation: 'listPhone',
        durationMs: 1,
        status: 'throttled',
      });
    }
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const service = new AxlAPIService({
      tlsMode: 'secure',
      requestTimeoutMs: 60_000,
      clientCacheMaxEntries: 2,
    });
    const outcome = service
      .executeOperation(
        creds,
        'getPhone',
        { name: 'SEP111' },
        undefined,
        'secure',
        STRICT_AXL_EXECUTION_POLICY,
        controller.signal
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(outcome).resolves.toMatchObject({ code: 'AXL_REQUEST_CANCELLED' });
    expect(mockClient.executeOperation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    await flushAuditLog();
    const beforeAdvance = (await import('node:fs')).readFileSync(
      auditLogPathForHost(creds.host),
      'utf-8'
    );
    expect(JSON.parse(beforeAdvance.trim().split('\n').at(-1) ?? '{}')).toMatchObject({
      status: 'error',
      errorCode: 'AXL_REQUEST_CANCELLED',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await flushAuditLog();
    expect((await import('node:fs')).readFileSync(auditLogPathForHost(creds.host), 'utf-8')).toBe(
      beforeAdvance
    );
    removeListener.mockRestore();
    vi.useRealTimers();
  });

  it('cancels retry backoff promptly after one dispatch without leaving a later retry', async () => {
    vi.useFakeTimers();
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '3';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '10000';
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: { markDispatched(): void }
      ) => {
        lifecycle.markDispatched();
        return Promise.reject(new Error('503 Service Unavailable'));
      }
    );
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const service = new AxlAPIService({
      tlsMode: 'secure',
      requestTimeoutMs: 60_000,
      clientCacheMaxEntries: 2,
    });
    const outcome = service
      .executeOperation(
        creds,
        'getPhone',
        { name: 'SEP111' },
        undefined,
        'secure',
        STRICT_AXL_EXECUTION_POLICY,
        controller.signal
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();
    controller.abort();

    await expect(outcome).resolves.toMatchObject({ code: 'AXL_REQUEST_CANCELLED' });
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    await flushAuditLog();
    const beforeAdvance = (await import('node:fs')).readFileSync(
      auditLogPathForHost(creds.host),
      'utf-8'
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await flushAuditLog();
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();
    expect((await import('node:fs')).readFileSync(auditLogPathForHost(creds.host), 'utf-8')).toBe(
      beforeAdvance
    );
    removeListener.mockRestore();
    if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
    else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
    if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
    vi.useRealTimers();
  });

  it('classifies a timed-out mutation as unknown after dispatch', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: { markDispatched(): void }
      ) => {
        lifecycle.markDispatched();
        return new Promise(resolve => setTimeout(() => resolve({ return: { ok: true } }), 20));
      }
    );

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
      });
      const pending = service.executeOperation(creds, 'updatePhone', { name: 'SEP111' });
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(20);

      await expect(outcome).resolves.toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
      expect(mockClient.executeOperation).toHaveBeenCalledOnce();
      await flushAuditLog();
      const entries = (await import('node:fs'))
        .readFileSync(auditLogPathForHost(creds.host), 'utf-8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(entries.at(-1)).toMatchObject({
        status: 'error',
        errorCode: 'AXL_MUTATION_OUTCOME_UNKNOWN',
        category: 'AXL_MUTATION_OUTCOME_UNKNOWN',
      });
      expect(stderr.mock.calls.flat().join('')).toContain('axl_timeout_mutation_outcome_unknown');
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight transport when the shared deadline expires', async () => {
    vi.useFakeTimers();
    let aborted = false;
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: {
          markDispatched(): void;
          signal: AbortSignal;
        }
      ) => {
        lifecycle.markDispatched();
        return new Promise((_resolve, reject) => {
          lifecycle.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('request aborted'));
          });
        });
      }
    );

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
      });
      const pending = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      await expect(outcome).resolves.toMatchObject({ code: 'AXL_READ_TIMEOUT' });
      expect(aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a never-ending dispatched transport when the controlled shutdown signal aborts', async () => {
    let transportAborted = false;
    let resolveTransport!: (value: unknown) => void;
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: {
          markDispatched(): void;
          signal: AbortSignal;
        }
      ) => {
        lifecycle.markDispatched();
        lifecycle.signal.addEventListener('abort', () => {
          transportAborted = true;
        });
        return new Promise(resolve => {
          resolveTransport = resolve;
        });
      }
    );
    const controller = new AbortController();
    const service = new AxlAPIService({
      tlsMode: 'secure',
      requestTimeoutMs: 60_000,
      clientCacheMaxEntries: 2,
    });
    const outcome = service
      .executeOperation(
        creds,
        'getPhone',
        { name: 'SEP111' },
        undefined,
        'secure',
        STRICT_AXL_EXECUTION_POLICY,
        controller.signal
      )
      .catch((error: unknown) => error);

    await Promise.resolve();
    controller.abort();

    await expect(
      Promise.race([
        outcome,
        new Promise(resolve => setTimeout(() => resolve('still-pending'), 25)),
      ])
    ).resolves.toMatchObject({ code: 'AXL_REQUEST_CANCELLED' });
    expect(transportAborted).toBe(true);
    await flushAuditLog();
    const beforeLateTransportResolution = (await import('node:fs')).readFileSync(
      auditLogPathForHost(creds.host),
      'utf-8'
    );
    expect(
      JSON.parse(beforeLateTransportResolution.trim().split('\n').at(-1) ?? '{}')
    ).toMatchObject({
      status: 'error',
      errorCode: 'AXL_REQUEST_CANCELLED',
    });
    resolveTransport({ return: { phone: [{ name: 'late-result' }] } });
    await Promise.resolve();
    await Promise.resolve();
    await flushAuditLog();
    expect((await import('node:fs')).readFileSync(auditLogPathForHost(creds.host), 'utf-8')).toBe(
      beforeLateTransportResolution
    );
  });

  it.each([
    [
      'successful dispatch',
      () => mockClient.executeOperation.mockResolvedValue({ return: { phone: [] } }),
    ],
    [
      'failed dispatch',
      () => mockClient.executeOperation.mockRejectedValue(new Error('401 Unauthorized')),
    ],
  ])('clears its deadline timer after a %s', async (_label, arrange) => {
    vi.useFakeTimers();
    arrange();

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 1_000,
        clientCacheMaxEntries: 2,
      });
      await service.executeOperation(creds, 'getPhone', { name: 'SEP111' }).catch(() => undefined);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redacts resolved host, username, and password from a normal response', async () => {
    const privateCredentials = {
      host: 'private-cluster.internal',
      username: 'private-user',
      password: 'private-password',
      version: '14.0',
    };
    mockClient.executeOperation.mockResolvedValue({
      return: {
        endpoint: `https://${privateCredentials.host}:8443/axl/`,
        diagnostics: `${privateCredentials.username}:${privateCredentials.password}`,
      },
    });

    const result = await new AxlAPIService().executeOperation(privateCredentials, 'getPhone', {
      name: 'SEP111',
    });
    const serialized = JSON.stringify(result);

    for (const value of Object.values(privateCredentials).slice(0, 3)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('redacts resolved host, username, and password from a single transport error', async () => {
    const privateCredentials = {
      host: 'private-cluster.internal',
      username: 'private-user',
      password: 'private-password',
      version: '14.0',
    };
    mockClient.executeOperation.mockRejectedValue(
      new Error(
        `401 authentication failed for ${privateCredentials.host} as ${privateCredentials.username}:${privateCredentials.password}`
      )
    );

    const failure = await new AxlAPIService()
      .executeOperation(privateCredentials, 'getPhone', { name: 'SEP111' })
      .catch((error: unknown) => error);
    const serialized = JSON.stringify(failure, Object.getOwnPropertyNames(failure as object));

    for (const value of Object.values(privateCredentials).slice(0, 3)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('redacts resolved credentials from auto-page failures', async () => {
    const privateCredentials = {
      host: 'private-cluster.internal',
      username: 'private-user',
      password: 'private-password',
      version: '14.0',
    };
    mockClient.executeOperation.mockRejectedValue(
      new Error(
        `https://${privateCredentials.username}:${privateCredentials.password}@${privateCredentials.host}:8443/axl/ failed`
      )
    );

    const failure = await new AxlAPIService()
      .listAll(privateCredentials, 'listPhone', { searchCriteria: { name: '%' } })
      .catch((error: unknown) => error);
    const serialized = JSON.stringify(failure, Object.getOwnPropertyNames(failure as object));

    for (const value of Object.values(privateCredentials).slice(0, 3)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('redacts resolved credentials from retry audit entries and uses an opaque audit path', async () => {
    const privateCredentials = {
      host: 'private-cluster.internal',
      username: 'private-user',
      password: 'private-password',
      version: '14.0',
    };
    const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
    const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
    mockClient.executeOperation.mockRejectedValue(
      new Error(
        `503 https://${privateCredentials.username}:${privateCredentials.password}@${privateCredentials.host}:8443/axl/ failed`
      )
    );

    try {
      await new AxlAPIService()
        .executeOperation(privateCredentials, 'getPhone', { name: 'SEP111' })
        .catch(() => undefined);
      await flushAuditLog();
      const path = auditLogPathForHost(privateCredentials.host);
      const content = (await import('node:fs')).readFileSync(path, 'utf-8');
      expect(content).toContain('"status":"retry"');
      expect(path).not.toContain(privateCredentials.host);
      for (const value of Object.values(privateCredentials).slice(0, 3)) {
        expect(content).not.toContain(value);
      }
    } finally {
      if (originalRetries === undefined) delete process.env.AXL_MCP_MAX_RETRIES;
      else process.env.AXL_MCP_MAX_RETRIES = originalRetries;
      if (originalDelay === undefined) delete process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      else process.env.AXL_MCP_RETRY_BASE_DELAY_MS = originalDelay;
    }
  });

  it('records successful operation to audit log', async () => {
    const service = new AxlAPIService();
    await service.executeOperation(creds, 'listPhone', { searchCriteria: { name: '%' } });

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

      await flushAuditLog();
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

  it('keeps an ambiguous MCP mutation single-dispatch, redacted, and grant-consumed', async () => {
    const request = {
      credentials: { ...creds, version: '14.0' },
      tlsMode: 'secure' as const,
      operation: 'updatePhone',
      data: { name: 'SEP111', description: 'policy write' },
    };
    const replayStore = new MutationGrantReplayStore();
    const mutationGrant = await createMutationGrant({
      request,
      packageVersion: AXL_RUNNER_PACKAGE_VERSION,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      id: 'mcp-ambiguous-write',
    });
    mockClient.executeOperation.mockRejectedValue(
      Object.assign(new Error(`timeout while authenticating ${creds.password}`), {
        code: 'ETIMEDOUT',
      })
    );

    const options = {
      request,
      source: 'mcp' as const,
      validationMode: 'strict' as const,
      mutationGrant,
    };
    const dependencies = {
      service: new AxlAPIService(),
      replayStore,
      packageVersion: AXL_RUNNER_PACKAGE_VERSION,
    };
    const failure = await runAxl(options, dependencies).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
    expect((failure as Error).message).toContain('reconciliation');
    expect((failure as Error).message).not.toContain('retry this request');
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const auditEntries = readFileSync(auditLogPathForHost(creds.host), 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({ operation: 'updatePhone', status: 'error' });
    expect(JSON.stringify(auditEntries)).not.toContain(creds.password);

    await expect(runAxl(options, dependencies)).rejects.toMatchObject({
      code: 'AXL_MUTATION_GRANT_REPLAYED',
    });
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();
  });

  it('keeps a grant-approved SQL query single-dispatch with an unknown outcome', async () => {
    const request = {
      credentials: { ...creds, version: '14.0' },
      tlsMode: 'secure' as const,
      operation: 'executeSQLQuery',
      data: { sql: "SELECT name FROM v_device WHERE name = 'SEP111'" },
    };
    const replayStore = new MutationGrantReplayStore();
    const mutationGrant = await createMutationGrant({
      request,
      packageVersion: AXL_RUNNER_PACKAGE_VERSION,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      id: 'mcp-ambiguous-sql-query',
    });
    mockClient.executeOperation.mockRejectedValue(
      Object.assign(new Error(`timeout while querying ${creds.password}`), { code: 'ETIMEDOUT' })
    );

    const options = {
      request,
      source: 'mcp' as const,
      validationMode: 'strict' as const,
      mutationGrant,
    };
    const dependencies = {
      service: new AxlAPIService(),
      replayStore,
      packageVersion: AXL_RUNNER_PACKAGE_VERSION,
    };
    const failure = await runAxl(options, dependencies).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
    expect((failure as Error).message).toContain('reconciliation');
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();
    await expect(runAxl(options, dependencies)).rejects.toMatchObject({
      code: 'AXL_MUTATION_GRANT_REPLAYED',
    });
    expect(mockClient.executeOperation).toHaveBeenCalledOnce();
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
    'treats executeSQLQueryInactive as an ambiguous CUCM %s mutation with one dispatch',
    async version => {
      const originalRetries = process.env.AXL_MCP_MAX_RETRIES;
      const originalDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
      process.env.AXL_MCP_MAX_RETRIES = '1';
      process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';
      mockClient.executeOperation.mockRejectedValue(new Error('503 Service Unavailable'));

      try {
        const service = new AxlAPIService();
        const failure = await service
          .executeOperation(
            { ...creds, version },
            'executeSQLQueryInactive',
            {
              sql: 'select name from device',
            },
            undefined,
            'secure',
            STRICT_AXL_EXECUTION_POLICY
          )
          .catch((error: unknown) => error);

        expect(failure).toMatchObject({ code: 'AXL_MUTATION_OUTCOME_UNKNOWN' });
        expect(mockClient.executeOperation).toHaveBeenCalledOnce();
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

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
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

    await flushAuditLog();
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(auditLogPathForHost(creds.host), 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBe(1); // single object counted as 1 row
  });
});

describe('AxlAPIService.listAll (integrated)', () => {
  it('snapshots the auto-pagination cap at service construction', async () => {
    const originalMax = process.env.AXL_MCP_MAX_AUTOPAGINATE;
    process.env.AXL_MCP_MAX_AUTOPAGINATE = '1000';
    const rows = Array.from({ length: 1_000 }, (_, index) => ({ name: `SEP${index}` }));
    mockClient.executeOperation.mockResolvedValue({ return: { phone: rows } });

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 30_000,
        clientCacheMaxEntries: 2,
      });
      process.env.AXL_MCP_MAX_AUTOPAGINATE = '3000';

      const result = await service.listAll(creds, 'listPhone', { searchCriteria: { name: '%' } });

      expect(result).toMatchObject({ pages: 1, totalFetched: 1_000, truncated: true });
      expect(mockClient.executeOperation).toHaveBeenCalledOnce();
    } finally {
      if (originalMax === undefined) delete process.env.AXL_MCP_MAX_AUTOPAGINATE;
      else process.env.AXL_MCP_MAX_AUTOPAGINATE = originalMax;
    }
  });

  it('uses one injected monotonic deadline across auto-pagination pages', async () => {
    vi.useFakeTimers();
    let monotonicNow = 0;
    let calls = 0;
    mockClient.executeOperation.mockImplementation(
      (
        _operation: unknown,
        _tags: unknown,
        _opts: unknown,
        lifecycle: { markDispatched(): void }
      ) => {
        lifecycle.markDispatched();
        calls++;
        return new Promise(resolve =>
          setTimeout(() => {
            monotonicNow += 6;
            resolve({
              return: {
                phone:
                  calls === 1
                    ? Array.from({ length: 1000 }, (_, index) => ({ name: `P${index}` }))
                    : [],
              },
            });
          }, 6)
        );
      }
    );

    try {
      const service = new AxlAPIService({
        tlsMode: 'secure',
        requestTimeoutMs: 10,
        clientCacheMaxEntries: 2,
        clock: { now: () => monotonicNow },
      });
      const pending = service.listAll(creds, 'listPhone', {});
      const outcome = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(12);

      await expect(outcome).resolves.toMatchObject({ code: 'AXL_READ_TIMEOUT' });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paginates through real executeOperation', async () => {
    let callCount = 0;
    const release = vi.fn();
    mockAcquireAxlClientLease.mockReturnValue({ client: mockClient, release });
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
    expect(mockAcquireAxlClientLease).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
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
