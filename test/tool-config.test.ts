import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnabledTopLevelObjects, isSqlEnabled, loadMcpConfig } from '../src/lib/tool-config';

describe('getEnabledTopLevelObjects', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  it('defaults to secure, SQL-disabled, deny-all configuration', () => {
    const config = loadMcpConfig({}, ['node', 'script.js']);

    expect(config.tlsMode).toBe('secure');
    expect(config.sqlEnabled).toBe(false);
    expect(config.enabledObjects).not.toBeNull();
    expect(config.enabledObjects?.size).toBe(0);
    expect(config.allowGlobalActions).toBe(false);
    expect(config.allowInlineCredentials).toBe(false);
  });

  it('does not expose a mutable enabled-object policy after startup resolution', () => {
    const config = loadMcpConfig({ AXL_MCP_ENABLED_OBJECTS: 'Phone' }, ['node', 'script.js']);

    expect(config.enabledObjects).not.toBeNull();
    expect([...config.enabledObjects!]).toEqual(['Phone']);
    expect('add' in (config.enabledObjects as object)).toBe(false);
  });

  it('implements the complete read-only Set protocol without exposing mutation', () => {
    const config = loadMcpConfig({ AXL_MCP_ENABLED_OBJECTS: 'Phone,User' }, ['node', 'script.js']);
    const enabled = config.enabledObjects!;
    const visited: string[] = [];
    let callbackSet: ReadonlySet<string> | undefined;

    enabled.forEach((value, duplicate, set) => {
      expect(duplicate).toBe(value);
      visited.push(value);
      callbackSet = set;
    });

    expect(enabled.size).toBe(2);
    expect(enabled.has('Phone')).toBe(true);
    expect([...enabled.keys()]).toEqual(['Phone', 'User']);
    expect([...enabled.values()]).toEqual(['Phone', 'User']);
    expect([...enabled.entries()]).toEqual([
      ['Phone', 'Phone'],
      ['User', 'User'],
    ]);
    expect(visited).toEqual(['Phone', 'User']);
    expect(callbackSet).toBe(enabled);
    expect(enabled.union(new Set(['Line']))).toEqual(new Set(['Phone', 'User', 'Line']));
    expect(enabled.intersection(new Set(['User', 'Line']))).toEqual(new Set(['User']));
    expect(enabled.difference(new Set(['User']))).toEqual(new Set(['Phone']));
    expect(enabled.symmetricDifference(new Set(['User', 'Line']))).toEqual(
      new Set(['Phone', 'Line'])
    );
    expect(enabled.isSubsetOf(new Set(['Phone', 'User', 'Line']))).toBe(true);
    expect(enabled.isSupersetOf(new Set(['Phone']))).toBe(true);
    expect(enabled.isDisjointFrom(new Set(['Line']))).toBe(true);
  });

  it('parses AXL_MCP_ENABLED_OBJECTS env var', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone,User';
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
    expect(result!.has('User' as any)).toBe(true);
    expect(result!.size).toBe(2);
  });

  it('parses AXL_MCP_CONFIG JSON with enabled_objects key', () => {
    process.env.AXL_MCP_CONFIG = '{"enabled_objects": ["Phone", "Line"]}';
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
    expect(result!.has('Line' as any)).toBe(true);
  });

  it('parses AXL_MCP_CONFIG JSON with enabledObjects camelCase key', () => {
    process.env.AXL_MCP_CONFIG = '{"enabledObjects": ["Phone"]}';
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
  });

  it('parses --enabled-objects=Phone,User argv (equals form)', () => {
    process.argv = ['node', 'script.js', '--enabled-objects=Phone,User'];
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
    expect(result!.has('User' as any)).toBe(true);
  });

  it('parses --enabled-objects Phone,User argv (space form)', () => {
    process.argv = ['node', 'script.js', '--enabled-objects', 'Phone,User'];
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
    expect(result!.has('User' as any)).toBe(true);
  });

  it('argv takes precedence over env var', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone,User,Line';
    process.argv = ['node', 'script.js', '--enabled-objects=Phone'];
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
    expect(result!.has('Phone' as any)).toBe(true);
  });

  it('env var takes precedence over JSON config', () => {
    process.env.AXL_MCP_CONFIG = '{"enabled_objects": ["Line"]}';
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.size).toBe(1);
    expect(result!.has('Phone' as any)).toBe(true);
  });

  it('returns null for "*" wildcard', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = '*';
    expect(getEnabledTopLevelObjects()).toBeNull();
  });

  it('returns null for "all" wildcard (case-insensitive)', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'ALL';
    expect(getEnabledTopLevelObjects()).toBeNull();
  });

  it('throws McpError for invalid object names', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone,BogusObject';
    expect(() => getEnabledTopLevelObjects()).toThrow('Unknown enabled_objects: BogusObject');
  });

  it('throws McpError for invalid JSON in AXL_MCP_CONFIG', () => {
    process.env.AXL_MCP_CONFIG = '{bad json}';
    expect(() => getEnabledTopLevelObjects()).toThrow('Invalid AXL_MCP_CONFIG JSON');
  });

  it('trims whitespace from object names', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = ' Phone , User ';
    const result = getEnabledTopLevelObjects();
    expect(result).not.toBeNull();
    expect(result!.has('Phone' as any)).toBe(true);
    expect(result!.has('User' as any)).toBe(true);
  });

  it('returns an empty deny-all set for empty list', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = '';
    expect(getEnabledTopLevelObjects()).toEqual(new Set());
  });

  it('fails closed on a misspelled SQL boolean', () => {
    process.env.AXL_MCP_ENABLE_SQL = 'flase';

    expect(() => isSqlEnabled()).toThrowError(
      expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
    );
  });

  it('rejects a boolean where a positive integer timeout is required', () => {
    process.env.AXL_MCP_CONFIG = '{"request_timeout_ms": true}';

    expect(() => loadMcpConfig()).toThrowError(
      expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
    );
  });

  it.each([
    'tls_mode',
    'tlsMode',
    'enable_sql',
    'enableSql',
    'enabled_objects',
    'enabledObjects',
    'allow_global_actions',
    'allowGlobalActions',
    'allow_inline_credentials',
    'allowInlineCredentials',
    'request_timeout_ms',
    'requestTimeoutMs',
    'client_cache_max_entries',
    'clientCacheMaxEntries',
  ])('rejects an explicitly null JSON config field: %s', field => {
    process.env.AXL_MCP_CONFIG = JSON.stringify({ [field]: null });

    expect(() => loadMcpConfig()).toThrowError(
      expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
    );
  });

  it.each([
    ['tls_mode', true],
    ['enable_sql', []],
    ['enabled_objects', true],
    ['allow_global_actions', []],
    ['allow_inline_credentials', {}],
    ['request_timeout_ms', true],
    ['client_cache_max_entries', []],
  ])('rejects an invalid JSON type for %s', (field, value) => {
    process.env.AXL_MCP_CONFIG = JSON.stringify({ [field]: value });

    expect(() => loadMcpConfig()).toThrowError(
      expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
    );
  });

  it.each([
    ['tls_mode', 'tlsMode', 'secure', 'secure'],
    ['enable_sql', 'enableSql', false, false],
    ['enabled_objects', 'enabledObjects', ['Phone'], ['Phone']],
    ['allow_global_actions', 'allowGlobalActions', false, false],
    ['allow_inline_credentials', 'allowInlineCredentials', false, false],
    ['request_timeout_ms', 'requestTimeoutMs', 30_000, 30_000],
    ['client_cache_max_entries', 'clientCacheMaxEntries', 16, 16],
    ['enable_sql', 'enableSql', null, true],
    ['enabled_objects', 'enabledObjects', null, ['*']],
  ])(
    'rejects simultaneous snake and camel JSON aliases: %s and %s',
    (snake, camel, snakeValue, camelValue) => {
      process.env.AXL_MCP_CONFIG = JSON.stringify({
        [snake]: snakeValue,
        [camel]: camelValue,
      });

      expect(() => loadMcpConfig()).toThrowError(
        expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
      );
    }
  );

  it('fails closed on malformed shared JSON even when only SQL is read', () => {
    process.env.AXL_MCP_CONFIG = '{bad json}';

    expect(() => isSqlEnabled()).toThrowError(
      expect.objectContaining({ code: 'AXL_CONFIG_INVALID' })
    );
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses exact SQL boolean %s', (value, expected) => {
    process.env.AXL_MCP_ENABLE_SQL = value;
    expect(isSqlEnabled()).toBe(expected);
  });
});
