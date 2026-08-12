import CiscoAxlService from 'cisco-axl';
import { createHmac, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { CucmCredentials } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';

export type TlsMode = 'secure' | 'insecure';

export interface McpTlsEnvironment {
  CUCM_AXL_TLS_MODE?: string;
  MCP_TLS_MODE?: string;
}

export function assertTlsMode(value: unknown): asserts value is TlsMode {
  if (value !== 'secure' && value !== 'insecure') {
    throw new AxlPolicyError('AXL_TLS_MODE_INVALID', `Invalid TLS mode "${String(value)}"`);
  }
}

/** Preserve legacy MCP compatibility only when TLS mode is genuinely unset or explicitly valid. */
export function resolveMcpTlsMode(environment: McpTlsEnvironment): TlsMode {
  const configured =
    environment.CUCM_AXL_TLS_MODE !== undefined
      ? { field: 'CUCM_AXL_TLS_MODE', value: environment.CUCM_AXL_TLS_MODE }
      : environment.MCP_TLS_MODE !== undefined
        ? { field: 'MCP_TLS_MODE', value: environment.MCP_TLS_MODE }
        : undefined;
  if (!configured) return 'insecure';
  if (typeof configured.value !== 'string') {
    throw new AxlPolicyError(
      'AXL_TLS_MODE_INVALID',
      `${configured.field} must be a primitive string`
    );
  }

  const value = configured.value.trim().toLowerCase();
  if (value === 'default' || value === 'insecure') return 'insecure';
  if (value === 'secure' || value === 'strict' || value === 'verify') return 'secure';
  throw new AxlPolicyError(
    'AXL_TLS_MODE_INVALID',
    `${configured.field} must be one of default, insecure, secure, strict, or verify`
  );
}

export interface ExecuteOperationOptions {
  clean?: boolean;
  dataContainerIdentifierTails?: string;
  removeAttributes?: boolean;
}

export interface AxlClient {
  executeOperation(
    operation: string,
    tags: unknown,
    opts?: ExecuteOperationOptions
  ): Promise<unknown>;
  testAuthentication(): Promise<boolean>;
}

interface SoapSecurity {
  addHttpHeaders?(headers: Record<string, string>): void;
  addOptions?(options: Record<string, unknown>): void;
}

interface SoapClient {
  security?: SoapSecurity;
  setSecurity(security: SoapSecurity): void;
}

interface CiscoAxlInternals extends AxlClient {
  _getClient?: () => Promise<SoapClient>;
}

const clientCache = new Map<string, AxlClient>();
const cacheIdentityKey = randomBytes(32);
const tlsConfiguredClients = new WeakSet<object>();

/** A process-local opaque identity; the password itself never enters the Map key. */
export function createAxlClientCacheIdentity(creds: CucmCredentials, tlsMode: TlsMode): string {
  assertTlsMode(tlsMode);
  const passwordIdentity = createHmac('sha256', cacheIdentityKey)
    .update(creds.password)
    .digest('hex');
  return `${creds.host}::${creds.username}::${creds.version}::${tlsMode}::${passwordIdentity}`;
}

function applyExplicitTls(service: CiscoAxlInternals, tlsMode: TlsMode): void {
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
        options.rejectUnauthorized = rejectUnauthorized;
        options.strictSSL = rejectUnauthorized;
        options.agentOptions = {
          ...((options.agentOptions as Record<string, unknown> | undefined) ?? {}),
          rejectUnauthorized,
        };
      },
    });
    tlsConfiguredClients.add(client);
    return client;
  };
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
    host: creds.host,
    version: creds.version,
    tlsMode,
    insecure: tlsMode === 'insecure',
  } as const;
}

export function getAxlClient(creds: CucmCredentials, tlsMode: TlsMode = 'secure'): AxlClient {
  assertTlsMode(tlsMode);
  const key = createAxlClientCacheIdentity(creds, tlsMode);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const service = new CiscoAxlService(
    creds.host,
    creds.username,
    creds.password,
    creds.version
  ) as unknown as CiscoAxlInternals;
  applyExplicitTls(service, tlsMode);

  const client: AxlClient = {
    executeOperation: service.executeOperation.bind(service),
    testAuthentication: () => testAuthentication(creds, tlsMode),
  };
  clientCache.set(key, client);
  return client;
}
