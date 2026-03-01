import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnabledTopLevelObjects } from '../src/lib/tool-config';

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

  it('returns null when no config is set', () => {
    expect(getEnabledTopLevelObjects()).toBeNull();
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

  it('returns null for empty list', () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = '';
    expect(getEnabledTopLevelObjects()).toBeNull();
  });
});
