import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCredentials } from '../src/lib/credential-resolver';
import { resolveAdmittedCredentials, type AxlToolRuntime } from '../src/lib/credential-resolver';
import type { CredentialSnapshot, CredentialSource } from '../src/lib/credential-source';
import { loadMcpConfig, type ResolvedMcpConfig } from '../src/lib/tool-config';
import { CREDENTIAL_SCOPE, getOptionalString, isRecord } from '../src/types/credentials';
import { isSupportedCucmVersion, SUPPORTED_CUCM_VERSIONS } from '../src/lib/version-manager';

describe('resolveCredentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CUCM_HOST = 'cucm.test.local';
    process.env.CUCM_USERNAME = 'admin';
    process.env.CUCM_PASSWORD = 'secret';
    process.env.CUCM_VERSION = '14.0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns credentials from env vars', () => {
    const result = resolveCredentials({});
    expect(result).toEqual({
      host: 'cucm.test.local',
      username: 'admin',
      password: 'secret',
      version: '14.0',
    });
  });

  it('rejects inline host, username, and password overrides unless compatibility is enabled', () => {
    const secret = 'inline-password-that-must-not-leak';

    expect(() => resolveCredentials({ cucm_password: secret })).toThrowError(
      expect.objectContaining({ code: 'AXL_INLINE_CREDENTIALS_DISABLED' })
    );
    try {
      resolveCredentials({ cucm_password: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('override cucm_host takes precedence over env', () => {
    const result = resolveCredentials({ cucm_host: 'other.local' }, process.env, {
      allowInlineCredentials: true,
    });
    expect(result.host).toBe('other.local');
  });

  it('override cucm_version takes precedence over env', () => {
    const result = resolveCredentials({ cucm_version: '15.0' });
    expect(result.version).toBe('15.0');
  });

  it('override cucm_username takes precedence over env', () => {
    const result = resolveCredentials({ cucm_username: 'override_user' }, process.env, {
      allowInlineCredentials: true,
    });
    expect(result.username).toBe('override_user');
  });

  it('override cucm_password takes precedence over env', () => {
    const result = resolveCredentials({ cucm_password: 'override_pass' }, process.env, {
      allowInlineCredentials: true,
    });
    expect(result.password).toBe('override_pass');
  });

  it('throws when CUCM_HOST missing', () => {
    delete process.env.CUCM_HOST;
    expect(() => resolveCredentials({})).toThrow('Missing CUCM_HOST or cucm_host');
  });

  it('throws when CUCM_USERNAME missing', () => {
    delete process.env.CUCM_USERNAME;
    expect(() => resolveCredentials({})).toThrow('Missing CUCM_USERNAME or cucm_username');
  });

  it('throws when CUCM_PASSWORD missing', () => {
    delete process.env.CUCM_PASSWORD;
    expect(() => resolveCredentials({})).toThrow('Missing CUCM_PASSWORD or cucm_password');
  });

  it('throws when CUCM_VERSION missing', () => {
    delete process.env.CUCM_VERSION;
    expect(() => resolveCredentials({})).toThrow('Missing CUCM_VERSION or cucm_version');
  });

  it('throws for unsupported version', () => {
    process.env.CUCM_VERSION = '9.0';
    expect(() => resolveCredentials({})).toThrow('Unsupported cucm_version "9.0"');
  });
});

describe('resolveAdmittedCredentials', () => {
  const providerConfig = loadMcpConfig(
    {
      CUCM_HOST: 'fixed.example.test',
      CUCM_VERSION: '11.5',
      AXL_MCP_CREDENTIAL_PROVIDER: JSON.stringify(['/opt/ct/bin/provider']),
      AXL_MCP_CREDENTIAL_TTL_S: '30',
      AXL_MCP_CREDENTIAL_MAX_STALE_S: '0',
    },
    ['node', 'test']
  );

  function snapshot(expiresAtMs: number): CredentialSnapshot {
    return {
      material: { username: 'provider-user', password: 'provider-password' },
      generation: 7,
      resolvedAtMs: 1_000,
      expiresAtMs,
      staleUntilMs: expiresAtMs,
      identityDigest: 'digest',
    };
  }

  function runtime(
    source: CredentialSource,
    now = 1_500,
    environment: NodeJS.ProcessEnv = {
      CUCM_HOST: 'startup.example.test',
      CUCM_VERSION: '14.0',
      CUCM_USERNAME: 'startup-user',
      CUCM_PASSWORD: 'startup-password',
    }
  ): AxlToolRuntime {
    return { credentialSource: source, startupEnvironment: environment, now: () => now };
  }

  it('composes one provider snapshot with the fixed target and generation', async () => {
    const current = snapshot(10_000);
    const source: CredentialSource = {
      initialize: async () => current,
      current: () => current,
      refresh: async () => current,
      shutdown: async () => undefined,
    };

    await expect(resolveAdmittedCredentials({}, providerConfig, runtime(source))).resolves.toEqual({
      host: 'fixed.example.test',
      username: 'provider-user',
      password: 'provider-password',
      version: '11.5',
      credentialGeneration: 7,
    });
  });

  it('carries the opaque provider scope into admitted credentials without serializing it', async () => {
    const scope = Object.freeze({});
    const current = { ...snapshot(10_000) };
    Object.defineProperty(current, CREDENTIAL_SCOPE, {
      value: scope,
      enumerable: false,
      writable: false,
    });
    const source: CredentialSource = {
      initialize: async () => current,
      current: () => current,
      refresh: async () => current,
      shutdown: async () => undefined,
    };

    const resolved = await resolveAdmittedCredentials({}, providerConfig, runtime(source));

    expect(resolved[CREDENTIAL_SCOPE]).toBe(scope);
    expect(Object.keys(resolved)).not.toContain('credentialScope');
    expect(JSON.stringify(resolved)).not.toContain('credentialScope');
  });

  it('rejects provider version drift before consulting the credential source', async () => {
    const current = snapshot(10_000);
    const source: CredentialSource = {
      initialize: async () => current,
      current: () => {
        throw new Error('source must not be consulted');
      },
      refresh: async () => current,
      shutdown: async () => undefined,
    };

    await expect(
      resolveAdmittedCredentials({ cucm_version: '14.0' }, providerConfig, runtime(source))
    ).rejects.toMatchObject({ code: 'AXL_TARGET_VERSION_DRIFT' });
  });

  it('refreshes an expired provider snapshot once before admission', async () => {
    const expired = snapshot(1_000);
    const refreshed = { ...snapshot(9_000), generation: 8 };
    let refreshCalls = 0;
    const source: CredentialSource = {
      initialize: async () => expired,
      current: () => expired,
      refresh: async trigger => {
        expect(trigger).toBe('ttl');
        refreshCalls += 1;
        return refreshed;
      },
      shutdown: async () => undefined,
    };

    await expect(
      resolveAdmittedCredentials({}, providerConfig, runtime(source))
    ).resolves.toMatchObject({
      credentialGeneration: 8,
      password: 'provider-password',
    });
    expect(refreshCalls).toBe(1);
  });

  it('uses the immutable startup environment for static compatibility resolution', async () => {
    const config: ResolvedMcpConfig = {
      ...providerConfig,
      credentialProvider: null,
      fixedTarget: null,
      allowInlineCredentials: true,
    };
    const source: CredentialSource = {
      initialize: async () => snapshot(Number.POSITIVE_INFINITY),
      current: () => snapshot(Number.POSITIVE_INFINITY),
      refresh: async () => snapshot(Number.POSITIVE_INFINITY),
      shutdown: async () => undefined,
    };
    const startupEnvironment = {
      CUCM_HOST: 'startup.example.test',
      CUCM_VERSION: '14.0',
      CUCM_USERNAME: 'startup-user',
      CUCM_PASSWORD: 'startup-password',
    };

    const resolved = await resolveAdmittedCredentials(
      {},
      config,
      runtime(source, 1_500, startupEnvironment)
    );
    startupEnvironment.CUCM_PASSWORD = 'mutated-live-value';

    expect(resolved).toEqual({
      host: 'startup.example.test',
      username: 'startup-user',
      password: 'startup-password',
      version: '14.0',
    });
  });
});

describe('getOptionalString', () => {
  it('returns string value when key exists', () => {
    expect(getOptionalString({ name: 'hello' }, 'name')).toBe('hello');
  });

  it('returns undefined when key does not exist', () => {
    expect(getOptionalString({}, 'name')).toBeUndefined();
  });

  it('returns undefined when value is not a string', () => {
    expect(getOptionalString({ count: 42 }, 'count')).toBeUndefined();
    expect(getOptionalString({ flag: true }, 'flag')).toBeUndefined();
  });
});

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe('isSupportedCucmVersion', () => {
  it('returns true for each supported version', () => {
    for (const version of SUPPORTED_CUCM_VERSIONS) {
      expect(isSupportedCucmVersion(version)).toBe(true);
    }
  });

  it('returns false for unsupported versions', () => {
    expect(isSupportedCucmVersion('9.0')).toBe(false);
    expect(isSupportedCucmVersion('13.0')).toBe(false);
    expect(isSupportedCucmVersion('16.0')).toBe(false);
    expect(isSupportedCucmVersion('')).toBe(false);
  });
});
