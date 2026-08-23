import CiscoAxlService from 'cisco-axl';
import { createHmac, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { CucmCredentials } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';
import { assertTlsMode, type TlsMode } from './tls-mode';
import { emitAxlDiagnostic } from './runtime-diagnostics';
export { emitAxlDiagnostic } from './runtime-diagnostics';
export { assertTlsMode, resolveMcpTlsMode, type McpTlsEnvironment, type TlsMode } from './tls-mode';

export interface ExecuteOperationOptions {
  clean?: boolean;
  dataContainerIdentifierTails?: string;
  removeAttributes?: boolean;
}

/** Per-dispatch control plane; contains no credentials or request payload. */
export interface AxlRequestLifecycle {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly markDispatched: () => void;
  readonly remainingTimeoutMs?: () => number;
}

export interface AxlClient {
  executeOperation(
    operation: string,
    tags: unknown,
    opts?: ExecuteOperationOptions,
    lifecycle?: AxlRequestLifecycle
  ): Promise<unknown>;
  testAuthentication(): Promise<boolean>;
}

export interface AxlClientLease {
  readonly client: AxlClient;
  release(): void;
}

interface SoapSecurity {
  addHttpHeaders?(headers: Record<string, string>): void;
  addOptions?(options: Record<string, unknown>): void;
}

interface SoapClient {
  security?: SoapSecurity;
  setSecurity(security: SoapSecurity): void;
  httpClient?: {
    _request?: (...args: unknown[]) => AbortableTransportRequest | undefined;
  };
}

interface AbortableTransportRequest {
  abort?(): void;
  destroy?(): void;
  once?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

interface CiscoAxlInternals extends AxlClient {
  _getClient?: () => Promise<SoapClient>;
}

export interface AxlClientCacheOptions {
  readonly maxEntries?: number;
  readonly idleTtlMs?: number;
  /** Maximum requests waiting behind the one active SOAP call for one cached client. */
  readonly maxQueuedRequests?: number;
  readonly onDiagnostic?: (event: 'hit' | 'miss' | 'eviction' | 'capacity' | 'overloaded') => void;
}

interface CachedAxlClient {
  client: AxlClient;
  readonly credentialGeneration?: number;
  leaseCount: number;
  retiring: boolean;
  lastUsedAt: number;
  activeRequests: number;
  queuedRequests: number;
  readonly shutdownController: AbortController;
}

interface PendingAxlRequest {
  readonly operation: string;
  readonly tags: unknown;
  readonly opts?: ExecuteOperationOptions;
  readonly lifecycle?: AxlRequestLifecycle;
  readonly queueSignal?: AbortSignal;
  started: boolean;
  settled: boolean;
  removeAbortListeners: () => void;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

const DEFAULT_CLIENT_CACHE_MAX_ENTRIES = 16;
const DEFAULT_CLIENT_CACHE_IDLE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLIENT_MAX_QUEUED_REQUESTS = 8;
const clientCache = new Map<string, CachedAxlClient>();
const clientEntries = new WeakMap<object, CachedAxlClient>();
const cacheIdentityKey = randomBytes(32);
let minimumProviderGeneration = 0;
const tlsConfiguredClients = new WeakSet<object>();
const abortConfiguredHttpClients = new WeakSet<object>();

/** A process-local opaque identity; the password itself never enters the Map key. */
export function createAxlClientCacheIdentity(creds: CucmCredentials, tlsMode: TlsMode): string {
  assertTlsMode(tlsMode);
  const passwordIdentity = createHmac('sha256', cacheIdentityKey)
    .update(creds.password)
    .digest('hex');
  const identityTuple = JSON.stringify([
    creds.host,
    creds.username,
    creds.version,
    passwordIdentity,
    tlsMode,
    creds.credentialGeneration ?? null,
  ]);
  return createHmac('sha256', cacheIdentityKey).update(identityTuple).digest('hex');
}

function applyExplicitTls(
  service: CiscoAxlInternals,
  tlsMode: TlsMode,
  getLifecycle: () => AxlRequestLifecycle | undefined
): void {
  assertTlsMode(tlsMode);
  if (typeof service._getClient !== 'function') return;
  const getClient = service._getClient.bind(service);
  const rejectUnauthorized = tlsMode === 'secure';

  service._getClient = async () => {
    const client = await getClient();
    if (tlsConfiguredClients.has(client)) return client;

    const existingSecurity = client.security;
    client.setSecurity({
      addHttpHeaders(headers) {
        existingSecurity?.addHttpHeaders?.(headers);
      },
      addOptions(options) {
        existingSecurity?.addOptions?.(options);
        const lifecycle = getLifecycle();
        if (lifecycle) {
          const timeoutMs = lifecycle.remainingTimeoutMs?.() ?? lifecycle.timeoutMs;
          if (timeoutMs <= 0 || lifecycle.signal?.aborted) {
            throw new Error('AXL request canceled before transport dispatch');
          }
          lifecycle.markDispatched();
          options.timeout = timeoutMs;
          options.timeoutMs = timeoutMs;
          if (lifecycle.signal) options.signal = lifecycle.signal;
        }
        options.rejectUnauthorized = rejectUnauthorized;
        options.strictSSL = rejectUnauthorized;
        options.agentOptions = {
          ...((options.agentOptions as Record<string, unknown> | undefined) ?? {}),
          rejectUnauthorized,
        };
      },
    });
    installTransportAbort(client, getLifecycle);
    tlsConfiguredClients.add(client);
    return client;
  };
}

/**
 * `@cypress/request` does not honor AbortSignal. Strong-soap exposes its request
 * factory, so bridge the request-local lifecycle to its supported abort/destroy
 * controls at the actual HTTP boundary.
 */
function installTransportAbort(
  client: SoapClient,
  getLifecycle: () => AxlRequestLifecycle | undefined
): void {
  const httpClient = client.httpClient;
  if (
    !httpClient ||
    typeof httpClient._request !== 'function' ||
    abortConfiguredHttpClients.has(httpClient)
  )
    return;
  const originalRequest = httpClient._request.bind(httpClient);
  httpClient._request = (...args: unknown[]) => {
    const originalCallback =
      typeof args[1] === 'function'
        ? (args[1] as (...callbackArgs: unknown[]) => unknown)
        : undefined;
    let callbackSettled = false;
    let cleanup: () => void = () => {};
    const settleCallback = (...callbackArgs: unknown[]) => {
      if (!originalCallback || callbackSettled) return;
      callbackSettled = true;
      cleanup();
      originalCallback(...callbackArgs);
    };
    const request = originalCallback
      ? originalRequest(args[0], settleCallback, ...args.slice(2))
      : originalRequest(...args);
    const signal = getLifecycle()?.signal;
    if (!request || !signal) return request;

    cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      if (typeof request.abort === 'function') request.abort();
      else request.destroy?.();
      settleCallback(new Error('AXL request canceled'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    for (const event of ['response', 'error', 'abort', 'close', 'complete']) {
      request.once?.(event, cleanup);
    }
    return request;
  };
  abortConfiguredHttpClients.add(httpClient);
}

function testAuthentication(creds: CucmCredentials, tlsMode: TlsMode): Promise<boolean> {
  const endpoint = new URL(`https://${creds.host}:8443/axl/`);
  const authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      endpoint,
      {
        method: 'GET',
        headers: { Authorization: authorization, Connection: 'keep-alive' },
        rejectUnauthorized: tlsMode === 'secure',
      },
      response => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          response.resume();
          resolve(false);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => resolve(body.includes('Cisco CallManager: AXL Web Service')));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export function getAxlClientDiagnostics(creds: CucmCredentials, tlsMode: TlsMode) {
  assertTlsMode(tlsMode);
  return {
    version: creds.version,
    tlsMode,
    insecure: tlsMode === 'insecure',
  } as const;
}

function resolveCacheOptions(
  options: AxlClientCacheOptions | undefined
): Required<AxlClientCacheOptions> {
  const maxEntries = options?.maxEntries ?? DEFAULT_CLIENT_CACHE_MAX_ENTRIES;
  const idleTtlMs = options?.idleTtlMs ?? DEFAULT_CLIENT_CACHE_IDLE_TTL_MS;
  const maxQueuedRequests = options?.maxQueuedRequests ?? DEFAULT_CLIENT_MAX_QUEUED_REQUESTS;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new AxlPolicyError(
      'AXL_CLIENT_CACHE_INVALID',
      'Client cache maximum must be a positive integer'
    );
  }
  if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1) {
    throw new AxlPolicyError(
      'AXL_CLIENT_CACHE_INVALID',
      'Client cache idle TTL must be a positive integer'
    );
  }
  if (!Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 1) {
    throw new AxlPolicyError(
      'AXL_CLIENT_CACHE_INVALID',
      'Client request queue maximum must be a positive integer'
    );
  }
  return {
    maxEntries,
    idleTtlMs,
    maxQueuedRequests,
    onDiagnostic: options?.onDiagnostic ?? (() => {}),
  };
}

function evictIdleClients(
  now: number,
  idleTtlMs: number,
  onDiagnostic: (event: 'eviction') => void
): void {
  for (const [key, entry] of clientCache) {
    if (
      entry.leaseCount === 0 &&
      entry.activeRequests === 0 &&
      entry.queuedRequests === 0 &&
      now - entry.lastUsedAt > idleTtlMs
    ) {
      clientCache.delete(key);
      onDiagnostic('eviction');
    }
  }
}

function assertProviderGenerationAdmitted(generation: number | undefined): void {
  if (generation === undefined) return;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AxlPolicyError(
      'AXL_CREDENTIAL_GENERATION_INVALID',
      'Credential generation is invalid'
    );
  }
  if (generation < minimumProviderGeneration) {
    throw new AxlPolicyError(
      'AXL_CREDENTIAL_GENERATION_RETIRED',
      'Credential generation is retired'
    );
  }
}

function drainRetiringEntry(key: string, entry: CachedAxlClient): void {
  if (
    !entry.retiring ||
    entry.leaseCount !== 0 ||
    entry.activeRequests !== 0 ||
    entry.queuedRequests !== 0 ||
    clientCache.get(key) !== entry
  ) {
    return;
  }
  clientCache.delete(key);
  emitAxlDiagnostic('credential_generation_drained');
}

function markRetiringEntries(): void {
  for (const [key, entry] of clientCache) {
    if (
      entry.credentialGeneration !== undefined &&
      entry.credentialGeneration < minimumProviderGeneration
    ) {
      if (!entry.retiring) {
        entry.retiring = true;
        emitAxlDiagnostic('credential_generation_draining');
      }
      drainRetiringEntry(key, entry);
    }
  }
}

/** Prevents new leases for this and every earlier provider generation. */
export function retireAxlClientGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AxlPolicyError(
      'AXL_CREDENTIAL_GENERATION_INVALID',
      'Credential generation is invalid'
    );
  }
  minimumProviderGeneration = Math.max(minimumProviderGeneration, generation + 1);
  markRetiringEntries();
}

/** Clears opaque cached clients during controlled shutdown or test isolation. */
export function clearAxlClientCache(): void {
  for (const entry of clientCache.values()) entry.shutdownController.abort();
  clientCache.clear();
}

/** Credential-free lifecycle counters for bounded-runtime diagnostics and soak tests. */
export function getAxlClientCacheDiagnostics(): {
  cachedClients: number;
  activeRequests: number;
  queuedRequests: number;
} {
  let activeRequests = 0;
  let queuedRequests = 0;
  for (const entry of clientCache.values()) {
    activeRequests += entry.activeRequests;
    queuedRequests += entry.queuedRequests;
  }
  return { cachedClients: clientCache.size, activeRequests, queuedRequests };
}

function composeLifecycleSignal(
  lifecycle: AxlRequestLifecycle | undefined,
  cacheSignal: AbortSignal
): { lifecycle: AxlRequestLifecycle | undefined; dispose: () => void } {
  if (!lifecycle) return { lifecycle, dispose: () => {} };
  const controller = new AbortController();
  const signals = [lifecycle.signal, cacheSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    lifecycle: { ...lifecycle, signal: controller.signal },
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

export function getAxlClient(
  creds: CucmCredentials,
  tlsMode: TlsMode = 'secure',
  cacheOptions?: AxlClientCacheOptions
): AxlClient {
  assertTlsMode(tlsMode);
  assertProviderGenerationAdmitted(creds.credentialGeneration);
  const cache = resolveCacheOptions(cacheOptions);
  const now = Date.now();
  evictIdleClients(now, cache.idleTtlMs, cache.onDiagnostic);
  const key = createAxlClientCacheIdentity(creds, tlsMode);
  const cached = clientCache.get(key);
  if (cached) {
    if (cached.retiring) {
      throw new AxlPolicyError(
        'AXL_CREDENTIAL_GENERATION_RETIRED',
        'Credential generation is retired'
      );
    }
    cached.lastUsedAt = now;
    clientCache.delete(key);
    clientCache.set(key, cached);
    cache.onDiagnostic('hit');
    return cached.client;
  }
  cache.onDiagnostic('miss');

  while (clientCache.size >= cache.maxEntries) {
    const oldestKey = [...clientCache.entries()].find(
      ([, entry]) =>
        entry.leaseCount === 0 && entry.activeRequests === 0 && entry.queuedRequests === 0
    )?.[0];
    if (oldestKey === undefined) break;
    clientCache.delete(oldestKey);
    cache.onDiagnostic('eviction');
  }
  if (clientCache.size >= cache.maxEntries) {
    cache.onDiagnostic('capacity');
    throw new AxlPolicyError(
      'AXL_CLIENT_CAPACITY',
      'AXL client capacity is exhausted by active or queued requests'
    );
  }

  const service = new CiscoAxlService(creds.host, creds.username, creds.password, creds.version, {
    // cisco-axl's default handler writes DEBUG request payloads to console.log.
    // The CLI and MCP service expose failures through their controlled outputs instead.
    logging: { level: 'error', handler: () => {} },
    retry: { retries: 0 },
  }) as unknown as CiscoAxlInternals;
  let activeLifecycle: AxlRequestLifecycle | undefined;
  const pendingRequests: PendingAxlRequest[] = [];
  let pump: () => void = () => {};
  const entry: CachedAxlClient = {
    client: undefined as unknown as AxlClient,
    credentialGeneration: creds.credentialGeneration,
    leaseCount: 0,
    retiring: false,
    lastUsedAt: now,
    activeRequests: 0,
    queuedRequests: 0,
    shutdownController: new AbortController(),
  };
  applyExplicitTls(service, tlsMode, () => activeLifecycle);

  const cancelError = () => new Error('AXL request canceled before client dispatch');
  const cancelPending = (pending: PendingAxlRequest) => {
    if (pending.started || pending.settled) return;
    pending.settled = true;
    pending.removeAbortListeners();
    const index = pendingRequests.indexOf(pending);
    if (index >= 0) pendingRequests.splice(index, 1);
    entry.queuedRequests = pendingRequests.length;
    pending.reject(cancelError());
    pump();
    drainRetiringEntry(key, entry);
  };

  pump = () => {
    if (entry.activeRequests > 0) return;
    const pending = pendingRequests.shift();
    if (!pending) return;
    entry.queuedRequests = pendingRequests.length;
    if (pending.settled) {
      pump();
      return;
    }

    pending.started = true;
    pending.removeAbortListeners();
    if (pending.queueSignal?.aborted || entry.shutdownController.signal.aborted) {
      pending.settled = true;
      pending.reject(cancelError());
      pump();
      drainRetiringEntry(key, entry);
      return;
    }

    entry.activeRequests++;
    const effectiveLifecycle = composeLifecycleSignal(
      pending.lifecycle,
      entry.shutdownController.signal
    );
    activeLifecycle = effectiveLifecycle.lifecycle;
    let operation: Promise<unknown>;
    try {
      operation = service.executeOperation(pending.operation, pending.tags, pending.opts);
    } catch (error) {
      operation = Promise.reject(error);
    }
    void Promise.resolve(operation)
      .then(
        value => {
          pending.settled = true;
          pending.resolve(value);
        },
        error => {
          pending.settled = true;
          pending.reject(error);
        }
      )
      .finally(() => {
        activeLifecycle = undefined;
        effectiveLifecycle.dispose();
        entry.activeRequests--;
        pump();
        drainRetiringEntry(key, entry);
      });
  };

  const client: AxlClient = {
    executeOperation: (operation, tags, opts, lifecycle) => {
      if (lifecycle?.signal?.aborted || entry.shutdownController.signal.aborted) {
        return Promise.reject(cancelError());
      }
      if (pendingRequests.length >= cache.maxQueuedRequests) {
        cache.onDiagnostic('overloaded');
        return Promise.reject(
          new AxlPolicyError(
            'AXL_CLIENT_OVERLOADED',
            'AXL client request queue is at capacity before dispatch'
          )
        );
      }
      return new Promise((resolve, reject) => {
        const pending: PendingAxlRequest = {
          operation,
          tags,
          opts,
          lifecycle,
          queueSignal: lifecycle?.signal,
          started: false,
          settled: false,
          removeAbortListeners: () => {},
          resolve,
          reject,
        };
        const abortQueued = () => cancelPending(pending);
        pending.removeAbortListeners = () => {
          pending.queueSignal?.removeEventListener('abort', abortQueued);
          entry.shutdownController.signal.removeEventListener('abort', abortQueued);
        };
        pendingRequests.push(pending);
        entry.queuedRequests = pendingRequests.length;
        pending.queueSignal?.addEventListener('abort', abortQueued, { once: true });
        entry.shutdownController.signal.addEventListener('abort', abortQueued, { once: true });
        pump();
      });
    },
    testAuthentication: () => testAuthentication(creds, tlsMode),
  };
  entry.client = client;
  clientCache.set(key, entry);
  clientEntries.set(client, entry);
  return client;
}

/** Acquires one cache lease for the complete lifetime of an admitted service request. */
export function acquireAxlClientLease(
  credentials: CucmCredentials,
  tlsMode: TlsMode = 'secure',
  cacheOptions?: AxlClientCacheOptions
): AxlClientLease {
  assertProviderGenerationAdmitted(credentials.credentialGeneration);
  const client = getAxlClient(credentials, tlsMode, cacheOptions);
  const entry = clientEntries.get(client);
  if (!entry) {
    throw new AxlPolicyError('AXL_CLIENT_CACHE_INVALID', 'AXL client cache entry is unavailable');
  }
  if (entry.retiring) {
    throw new AxlPolicyError(
      'AXL_CREDENTIAL_GENERATION_RETIRED',
      'Credential generation is retired'
    );
  }
  entry.leaseCount++;
  let released = false;
  const key = createAxlClientCacheIdentity(credentials, tlsMode);
  return {
    client,
    release: () => {
      if (released) return;
      released = true;
      entry.leaseCount = Math.max(0, entry.leaseCount - 1);
      drainRetiringEntry(key, entry);
    },
  };
}
