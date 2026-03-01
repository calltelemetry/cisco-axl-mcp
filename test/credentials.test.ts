import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCredentials } from '../src/lib/credential-resolver';
import { getOptionalString, isRecord } from '../src/types/credentials';
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

  it('override cucm_host takes precedence over env', () => {
    const result = resolveCredentials({ cucm_host: 'other.local' });
    expect(result.host).toBe('other.local');
  });

  it('override cucm_version takes precedence over env', () => {
    const result = resolveCredentials({ cucm_version: '15.0' });
    expect(result.version).toBe('15.0');
  });

  it('override cucm_username takes precedence over env', () => {
    const result = resolveCredentials({ cucm_username: 'override_user' });
    expect(result.username).toBe('override_user');
  });

  it('override cucm_password takes precedence over env', () => {
    const result = resolveCredentials({ cucm_password: 'override_pass' });
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
