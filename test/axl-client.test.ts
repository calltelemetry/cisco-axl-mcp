import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientObservations = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ host: string; user: string; password: string; version: string }>,
  requestOptions: [] as Array<Record<string, unknown>>,
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
        };
        this._getClient = async () => soapClient;
      }
      async executeOperation() {
        const soapClient = await this._getClient();
        const options: Record<string, unknown> = {};
        (
          soapClient.security as { addOptions?(options: Record<string, unknown>): void }
        ).addOptions?.(options);
        clientObservations.requestOptions.push(options);
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
  beforeEach(() => {
    vi.resetModules();
    clientObservations.constructorCalls.length = 0;
    clientObservations.requestOptions.length = 0;
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
      host: 'cucm-diagnostic.local',
      version: '15.0',
      tlsMode: 'insecure',
      insecure: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(creds.password);
    expect(JSON.stringify(diagnostics)).not.toContain(creds.username);
  });
});
