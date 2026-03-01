import { describe, it, expect } from 'vitest';
import { assertRecord, requireString, optionalObject, extractCredentialOverrides, requireNameOrUuid } from '../src/types/axl/guards';

describe('assertRecord', () => {
  it('returns record for valid object', () => {
    const obj = { key: 'value' };
    expect(assertRecord(obj)).toBe(obj);
  });

  it('throws for null', () => {
    expect(() => assertRecord(null)).toThrow('Invalid arguments');
  });

  it('throws for string', () => {
    expect(() => assertRecord('not an object')).toThrow('Invalid arguments');
  });

  it('throws for array', () => {
    expect(() => assertRecord([1, 2, 3])).toThrow('Invalid arguments');
  });

  it('uses custom message', () => {
    expect(() => assertRecord(null, 'custom error')).toThrow('custom error');
  });
});

describe('requireString', () => {
  it('returns string value', () => {
    expect(requireString({ name: 'test' }, 'name')).toBe('test');
  });

  it('throws for missing key', () => {
    expect(() => requireString({}, 'name')).toThrow('Missing or invalid "name"');
  });

  it('throws for non-string value', () => {
    expect(() => requireString({ name: 42 }, 'name')).toThrow('Missing or invalid "name"');
  });

  it('throws for empty string', () => {
    expect(() => requireString({ name: '  ' }, 'name')).toThrow('Missing or invalid "name"');
  });
});

describe('optionalObject', () => {
  it('returns undefined when key missing', () => {
    expect(optionalObject({}, 'opts')).toBeUndefined();
  });

  it('returns record when value is object', () => {
    const opts = { clean: true };
    expect(optionalObject({ opts }, 'opts')).toBe(opts);
  });

  it('throws when value is not an object', () => {
    expect(() => optionalObject({ opts: 'string' }, 'opts')).toThrow('Invalid "opts"');
  });
});

describe('extractCredentialOverrides', () => {
  it('extracts all credential fields', () => {
    const result = extractCredentialOverrides({
      cucm_host: 'host',
      cucm_username: 'user',
      cucm_password: 'pass',
      cucm_version: '14.0',
    });
    expect(result).toEqual({
      cucm_host: 'host',
      cucm_username: 'user',
      cucm_password: 'pass',
      cucm_version: '14.0',
    });
  });

  it('returns undefined for missing fields', () => {
    const result = extractCredentialOverrides({});
    expect(result.cucm_host).toBeUndefined();
    expect(result.cucm_username).toBeUndefined();
  });
});

describe('requireNameOrUuid', () => {
  it('returns name when provided', () => {
    expect(requireNameOrUuid({ name: 'SEP001122334455' })).toEqual({
      name: 'SEP001122334455',
      uuid: undefined,
    });
  });

  it('returns uuid when provided', () => {
    expect(requireNameOrUuid({ uuid: 'abc-123' })).toEqual({
      name: undefined,
      uuid: 'abc-123',
    });
  });

  it('returns both when both provided', () => {
    expect(requireNameOrUuid({ name: 'test', uuid: 'abc' })).toEqual({
      name: 'test',
      uuid: 'abc',
    });
  });

  it('throws when neither provided', () => {
    expect(() => requireNameOrUuid({})).toThrow('Must provide "name" or "uuid"');
  });
});
