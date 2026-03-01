import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cisco-axl before importing axl-client — must use class for `new`
vi.mock('cisco-axl', () => {
  return {
    default: class MockCiscoAxlService {
      _host: string;
      _user: string;
      _version: string;
      constructor(host: string, user: string, _pass: string, version: string) {
        this._host = host;
        this._user = user;
        this._version = version;
      }
      async executeOperation() { return { ok: true }; }
      async testAuthentication() { return true; }
    },
  };
});

import type { CucmCredentials } from '../src/types/credentials';

describe('getAxlClient', () => {
  beforeEach(() => {
    vi.resetModules();
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
});
