import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientObservations = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ host: string; user: string; password: string; version: string }>,
  requestOptions: [] as Array<Record<string, unknown>>,
  lifecycleMarks: 0,
  dispatchStarts: 0,
  nextOperationGate: undefined as Promise<void> | undefined,
  operationGates: [] as Promise<void>[],
  nextPostDispatchGate: undefined as Promise<void> | undefined,
  dispatchTransport: false,
  transportAbortCount: 0,
  transportCompletionCount: 0,
  transportCallback: undefined as ((...args: unknown[]) => void) | undefined,
}));

// Mock cisco-axl before importing axl-client — must use class for `new`
vi.mock('cisco-axl', () => {
  return {
    default: class MockCiscoAxlService {
      _host: string;
      _user: string;
      _version: string;
      _getClient: () => Promise<{
        security: { addHttpHeaders(headers: Record<string, string>): void };
        setSecurity(security: {
          addHttpHeaders(headers: Record<string, string>): void;
          addOptions?(options: Record<string, unknown>): void;
        }): void;
        httpClient: {
          _request(
            options: Record<string, unknown>,
            callback: (...args: unknown[]) => void
          ): {
            abort(): void;
            on(): void;
            once(): void;
            removeListener(): void;
          };
        };
      }>;
      constructor(host: string, user: string, password: string, version: string) {
        this._host = host;
        this._user = user;
        this._version = version;
        clientObservations.constructorCalls.push({ host, user, password, version });
        const soapClient = {
          security: {
            addHttpHeaders(headers: Record<string, string>) {
              headers.Authorization = 'Basic hidden';
            },
          },
          setSecurity(security: {
            addHttpHeaders(headers: Record<string, string>): void;
            addOptions?(options: Record<string, unknown>): void;
          }) {
            this.security = security;
          },
          httpClient: {
            _request(_options: Record<string, unknown>, callback: (...args: unknown[]) => void) {
              clientObservations.transportCallback = callback;
              return {
                abort() {
                  clientObservations.transportAbortCount++;
                },
                on() {},
                once() {},
                removeListener() {},
              };
            },
          },
        };
        this._getClient = async () => soapClient;
      }
      async executeOperation() {
        clientObservations.dispatchStarts++;
        const gate =
          clientObservations.operationGates.shift() ?? clientObservations.nextOperationGate;
        clientObservations.nextOperationGate = undefined;
        if (gate) await gate;
        const soapClient = await this._getClient();
        const options: Record<string, unknown> = {};
        (
          soapClient.security as { addOptions?(options: Record<string, unknown>): void }
        ).addOptions?.(options);
        clientObservations.requestOptions.push(options);
        if (clientObservations.dispatchTransport) {
          return new Promise((resolve, reject) => {
            soapClient.httpClient._request(options, error => {
              clientObservations.transportCompletionCount++;
              if (error) reject(error);
              else resolve({ ok: true });
            });
          });
        }
        const postDispatchGate = clientObservations.nextPostDispatchGate;
        clientObservations.nextPostDispatchGate = undefined;
        if (postDispatchGate) await postDispatchGate;
        return { ok: true };
      }
      async testAuthentication() {
        return true;
      }
    },
  };
});

import type { CucmCredentials } from '../src/types/credentials';

describe('getAxlClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    clientObservations.constructorCalls.length = 0;
    clientObservations.requestOptions.length = 0;
    clientObservations.lifecycleMarks = 0;
    clientObservations.dispatchStarts = 0;
    clientObservations.nextOperationGate = undefined;
    clientObservations.operationGates.length = 0;
    clientObservations.nextPostDispatchGate = undefined;
    clientObservations.dispatchTransport = false;
    clientObservations.transportAbortCount = 0;
    clientObservations.transportCompletionCount = 0;
    clientObservations.transportCallback = undefined;
    // Keep the intentionally isolated module cache warm outside individual
    // assertions. Parallel workers otherwise contend on this first import.
    await import('../src/lib/axl-client');
  });

  it('creates a client for given credentials', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const creds: CucmCredentials = {
      host: 'cucm1.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const client = getAxlClient(creds);
    expect(client).toBeDefined();
    expect(client.executeOperation).toBeDefined();
  });

  it('returns cached client for same credentials', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const creds: CucmCredentials = {
      host: 'cucm2.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const client1 = getAxlClient(creds);
    const client2 = getAxlClient(creds);
    expect(client1).toBe(client2);
  });

  it('evicts the least recently used client when the configured cache maximum is reached', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const cache = { maxEntries: 2, idleTtlMs: 15 * 60 * 1000 };
    const first: CucmCredentials = {
      host: 'lru-first.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const second = { ...first, host: 'lru-second.local' };
    const third = { ...first, host: 'lru-third.local' };

    const firstClient = getAxlClient(first, 'secure', cache);
    getAxlClient(second, 'secure', cache);
    expect(getAxlClient(first, 'secure', cache)).toBe(firstClient);
    getAxlClient(third, 'secure', cache);
    getAxlClient(second, 'secure', cache);

    expect(clientObservations.constructorCalls).toHaveLength(4);
  });

  it('evicts an idle client before returning it from the cache', async () => {
    vi.useFakeTimers();
    try {
      const { getAxlClient } = await import('../src/lib/axl-client');
      const creds: CucmCredentials = {
        host: 'idle-client.local',
        username: 'admin',
        password: 'secret',
        version: '14.0',
      };
      const cache = { maxEntries: 2, idleTtlMs: 15 * 60 * 1000 };

      const original = getAxlClient(creds, 'secure', cache);
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      const replacement = getAxlClient(creds, 'secure', cache);

      expect(replacement).not.toBe(original);
      expect(clientObservations.constructorCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes remaining transport budget and marks dispatch at the SOAP option boundary', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'timeout-options.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const controller = new AbortController();

    await getAxlClient(credentials).executeOperation('getPhone', { name: 'SEP1' }, undefined, {
      timeoutMs: 1234,
      signal: controller.signal,
      markDispatched: () => {
        clientObservations.lifecycleMarks++;
      },
    });

    expect(clientObservations.lifecycleMarks).toBe(1);
    expect(clientObservations.requestOptions.at(-1)).toMatchObject({
      timeout: 1234,
      timeoutMs: 1234,
      signal: controller.signal,
    });
  });

  it('serializes concurrent cached-client lifecycles without mixing their transport budgets', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'interleaved-client.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const marks: string[] = [];
    const client = getAxlClient(credentials);

    await Promise.all([
      client.executeOperation('getPhone', {}, undefined, {
        timeoutMs: 111,
        markDispatched: () => marks.push('first'),
      }),
      client.executeOperation('getPhone', {}, undefined, {
        timeoutMs: 222,
        markDispatched: () => marks.push('second'),
      }),
    ]);

    expect(marks).toEqual(['first', 'second']);
    expect(clientObservations.requestOptions.map(options => options.timeout)).toEqual([111, 222]);
  });

  it('cancels a queued cached-client operation before it reaches SOAP dispatch', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'queued-cancellation.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    let releaseFirst!: () => void;
    clientObservations.nextOperationGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const client = getAxlClient(credentials);
    const first = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 111,
      markDispatched: () => {
        clientObservations.lifecycleMarks++;
      },
    });
    await Promise.resolve();
    const queuedController = new AbortController();
    const queued = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 222,
      signal: queuedController.signal,
      markDispatched: () => {
        clientObservations.lifecycleMarks++;
      },
    });
    queuedController.abort();
    releaseFirst();

    await expect(first).resolves.toEqual({ ok: true });
    await expect(queued).rejects.toThrow('AXL request canceled before client dispatch');
    expect(clientObservations.lifecycleMarks).toBe(1);
    expect(clientObservations.requestOptions.map(options => options.timeout)).toEqual([111]);
  });

  it('releases a cancelled queue slot before the active client request settles', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'queue-slot-release.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    let releaseFirst!: () => void;
    clientObservations.nextOperationGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const client = getAxlClient(credentials, 'secure', { maxQueuedRequests: 1 });
    const active = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 111,
      markDispatched() {},
    });
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 222,
      signal: controller.signal,
      markDispatched() {},
    });
    controller.abort();

    await expect(cancelled).rejects.toThrow('AXL request canceled before client dispatch');
    const successor = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 333,
      markDispatched() {},
    });

    releaseFirst();
    await expect(active).resolves.toEqual({ ok: true });
    await expect(successor).resolves.toEqual({ ok: true });
    expect(clientObservations.requestOptions).toHaveLength(2);
  });

  it('unlinks a 2,000-call cancelled burst before successor dispatch and keeps the queue bounded', async () => {
    const { getAxlClient, getAxlClientCacheDiagnostics } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'cancelled-burst.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    let releaseActive!: () => void;
    clientObservations.nextOperationGate = new Promise<void>(resolve => {
      releaseActive = resolve;
    });
    const client = getAxlClient(credentials, 'secure', { maxQueuedRequests: 8 });
    const active = client.executeOperation('getPhone', {}, undefined, {
      timeoutMs: 111,
      markDispatched() {},
    });
    await Promise.resolve();

    const cancelled: Array<Promise<unknown>> = [];
    let highWaterQueued = 0;
    for (let index = 0; index < 2_000; index++) {
      const controller = new AbortController();
      cancelled.push(
        client
          .executeOperation('getPhone', { index }, undefined, {
            timeoutMs: 222,
            signal: controller.signal,
            markDispatched() {
              throw new Error('cancelled request dispatched');
            },
          })
          .catch(error => error)
      );
      highWaterQueued = Math.max(highWaterQueued, getAxlClientCacheDiagnostics().queuedRequests);
      controller.abort();
    }

    const outcomes = await Promise.all(cancelled);
    expect([
      ...new Set(outcomes.map(error => (error instanceof Error ? error.message : error))),
    ]).toEqual(['AXL request canceled before client dispatch']);
    expect(highWaterQueued).toBeLessThanOrEqual(8);
    expect(getAxlClientCacheDiagnostics().queuedRequests).toBe(0);

    const successor = client.executeOperation('getPhone', { successor: true }, undefined, {
      timeoutMs: 333,
      markDispatched() {},
    });
    releaseActive();
    await expect(active).resolves.toEqual({ ok: true });
    await Promise.resolve();
    expect(clientObservations.dispatchStarts).toBe(2);
    await expect(successor).resolves.toEqual({ ok: true });
  });

  it('fails closed instead of evicting active cached clients during credential churn', async () => {
    const { getAxlClient, getAxlClientCacheDiagnostics } = await import('../src/lib/axl-client');
    const base: CucmCredentials = {
      host: 'active-cache.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    clientObservations.operationGates.push(
      new Promise<void>(resolve => {
        releaseFirst = resolve;
      }),
      new Promise<void>(resolve => {
        releaseSecond = resolve;
      })
    );
    const cache = { maxEntries: 2, maxQueuedRequests: 1 };
    const first = getAxlClient(
      { ...base, host: 'active-one.local' },
      'secure',
      cache
    ).executeOperation('getPhone', {}, undefined, { timeoutMs: 111, markDispatched() {} });
    const second = getAxlClient(
      { ...base, host: 'active-two.local' },
      'secure',
      cache
    ).executeOperation('getPhone', {}, undefined, { timeoutMs: 222, markDispatched() {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(() =>
      getAxlClient({ ...base, host: 'active-three.local' }, 'secure', cache)
    ).toThrowError(expect.objectContaining({ code: 'AXL_CLIENT_CAPACITY' }));
    expect(getAxlClientCacheDiagnostics()).toEqual({
      cachedClients: 2,
      activeRequests: 2,
      queuedRequests: 0,
    });
    expect(clientObservations.constructorCalls).toHaveLength(2);

    releaseFirst();
    releaseSecond();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });

  it('settles an aborted strong-soap request once and releases its cached-client successor', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const credentials: CucmCredentials = {
      host: 'dispatched-cancellation.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    clientObservations.dispatchTransport = true;
    const controller = new AbortController();
    const pending = getAxlClient(credentials).executeOperation('getPhone', {}, undefined, {
      timeoutMs: 111,
      signal: controller.signal,
      markDispatched: () => {
        clientObservations.lifecycleMarks++;
      },
    });
    await vi.waitFor(() => expect(clientObservations.lifecycleMarks).toBe(1));
    controller.abort();

    expect(clientObservations.transportAbortCount).toBe(1);
    await expect(pending).rejects.toThrow('AXL request canceled');
    expect(clientObservations.transportCompletionCount).toBe(1);
    clientObservations.transportCallback?.(null, { statusCode: 200 }, 'late response');
    await Promise.resolve();
    expect(clientObservations.transportCompletionCount).toBe(1);

    clientObservations.dispatchTransport = false;
    await expect(
      getAxlClient(credentials).executeOperation('getPhone', {}, undefined, {
        timeoutMs: 222,
        markDispatched: () => {
          clientObservations.lifecycleMarks++;
        },
      })
    ).resolves.toEqual({ ok: true });
    expect(clientObservations.lifecycleMarks).toBe(2);
  });

  it('emits only bounded cache event names', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const events: string[] = [];
    const creds: CucmCredentials = {
      host: 'diagnostic-cache.local',
      username: 'admin',
      password: 'secret-that-must-not-be-diagnostic-data',
      version: '14.0',
    };

    getAxlClient(creds, 'secure', { onDiagnostic: event => events.push(event) });
    getAxlClient(creds, 'secure', { onDiagnostic: event => events.push(event) });

    expect(events).toEqual(['miss', 'hit']);
    expect(JSON.stringify(events)).not.toContain(creds.password);
  });

  it('returns different clients for different credentials', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const creds1: CucmCredentials = {
      host: 'cucm3.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };
    const creds2: CucmCredentials = {
      host: 'cucm4.local',
      username: 'admin',
      password: 'secret',
      version: '15.0',
    };
    const client1 = getAxlClient(creds1);
    const client2 = getAxlClient(creds2);
    expect(client1).not.toBe(client2);
  });

  it('uses a password-free cache identity while distinguishing changed passwords', async () => {
    const { createAxlClientCacheIdentity, getAxlClient } = await import('../src/lib/axl-client');
    const creds: CucmCredentials = {
      host: 'cucm-cache.local',
      username: 'admin',
      password: 'plain-text-password',
      version: '14.0',
    };

    const identity = createAxlClientCacheIdentity(creds, 'secure');
    const first = getAxlClient(creds, 'secure');
    const changed = getAxlClient({ ...creds, password: 'rotated-password' }, 'secure');

    expect(identity).not.toContain(creds.password);
    expect(identity).not.toContain('rotated-password');
    expect(first).not.toBe(changed);
  });

  it('keeps delimiter-ambiguous credential tuples in distinct cache identities and clients', async () => {
    const { createAxlClientCacheIdentity, getAxlClient } = await import('../src/lib/axl-client');
    const firstCredentials: CucmCredentials = {
      host: '2001::1',
      username: 'admin',
      password: 'shared-password',
      version: '14.0',
    };
    const secondCredentials: CucmCredentials = {
      host: '2001',
      username: '1::admin',
      password: 'shared-password',
      version: '14.0',
    };

    const firstIdentity = createAxlClientCacheIdentity(firstCredentials, 'secure');
    const secondIdentity = createAxlClientCacheIdentity(secondCredentials, 'secure');
    const firstClient = getAxlClient(firstCredentials, 'secure');
    const secondClient = getAxlClient(secondCredentials, 'secure');

    expect(firstIdentity).not.toBe(secondIdentity);
    expect(firstIdentity).not.toContain(firstCredentials.password);
    expect(secondIdentity).not.toContain(secondCredentials.password);
    expect(firstClient).not.toBe(secondClient);
    expect(clientObservations.constructorCalls).toHaveLength(2);
  });

  it.each([
    ['secure', true],
    ['insecure', false],
  ] as const)(
    'applies explicit %s TLS verification without changing process defaults',
    async (tlsMode, rejectUnauthorized) => {
      const originalGlobalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      const { getAxlClient } = await import('../src/lib/axl-client');
      const creds: CucmCredentials = {
        host: `cucm-${tlsMode}.local`,
        username: 'admin',
        password: 'secret',
        version: '14.0',
      };

      await getAxlClient(creds, tlsMode).executeOperation('getPhone', { name: 'SEP1' });

      expect(clientObservations.requestOptions.at(-1)).toMatchObject({
        rejectUnauthorized,
        strictSSL: rejectUnauthorized,
      });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(originalGlobalTls);
    }
  );

  it('reports insecure mode in credential-free diagnostics', async () => {
    const { getAxlClientDiagnostics } = await import('../src/lib/axl-client');
    const creds: CucmCredentials = {
      host: 'cucm-diagnostic.local',
      username: 'axl-admin',
      password: 'must-not-appear',
      version: '15.0',
    };

    const diagnostics = getAxlClientDiagnostics(creds, 'insecure');

    expect(diagnostics).toEqual({
      version: '15.0',
      tlsMode: 'insecure',
      insecure: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(creds.password);
    expect(JSON.stringify(diagnostics)).not.toContain(creds.username);
  });

  it('rejects an unknown runtime TLS mode before constructing a client', async () => {
    const { getAxlClient } = await import('../src/lib/axl-client');
    const creds: CucmCredentials = {
      host: 'cucm-invalid-tls.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    };

    expect(() => getAxlClient(creds, 'unknown-tls' as 'secure')).toThrowError(
      expect.objectContaining({ code: 'AXL_TLS_MODE_INVALID' })
    );
    expect(clientObservations.constructorCalls).toHaveLength(0);
  });

  it.each([
    [{ CUCM_AXL_TLS_MODE: 'typo' }, 'CUCM_AXL_TLS_MODE'],
    [{ MCP_TLS_MODE: 'typo' }, 'MCP_TLS_MODE'],
    [{ CUCM_AXL_TLS_MODE: '', MCP_TLS_MODE: 'strict' }, 'CUCM_AXL_TLS_MODE'],
  ] as const)(
    'rejects an invalid configured MCP TLS environment %#',
    async (environment, field) => {
      const { resolveMcpTlsMode } = await import('../src/lib/axl-client');

      expect(() => resolveMcpTlsMode(environment)).toThrowError(
        expect.objectContaining({
          code: 'AXL_TLS_MODE_INVALID',
          message: expect.stringContaining(field),
        })
      );
    }
  );

  it.each([
    [{}, 'secure'],
    [{ CUCM_AXL_TLS_MODE: 'default' }, 'insecure'],
    [{ CUCM_AXL_TLS_MODE: 'insecure' }, 'insecure'],
    [{ CUCM_AXL_TLS_MODE: 'secure' }, 'secure'],
    [{ CUCM_AXL_TLS_MODE: 'strict' }, 'secure'],
    [{ MCP_TLS_MODE: 'verify' }, 'secure'],
  ] as const)('maps valid MCP TLS environment %# to %s', async (environment, expected) => {
    const { resolveMcpTlsMode } = await import('../src/lib/axl-client');

    expect(resolveMcpTlsMode(environment)).toBe(expected);
  });
});
