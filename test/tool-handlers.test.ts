import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleTool } from '../src/tools/index';
import type { AxlAPIService } from '../src/services/axl/index';
import { AXL_TOP_LEVEL_OBJECTS, AXL_OBJECTS_SOURCE_WSDL_VERSION } from '../src/types/generated/axl-objects';

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

function createCapturingMock() {
  const calls: { creds: unknown; operation: string; data: unknown; opts: unknown }[] = [];
  const api: AxlAPIService = {
    executeOperation: async (creds: unknown, operation: unknown, data: unknown, opts: unknown) => {
      calls.push({ creds, operation: String(operation), data, opts });
      return { ok: true };
    },
  } as unknown as AxlAPIService;
  return { api, calls };
}

const mockApi: AxlAPIService = {
  executeOperation: async () => ({ ok: true }),
} as unknown as AxlAPIService;

describe('axl_list_objects', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns all objects when no enabled_objects set', async () => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    const result = await handleTool('axl_list_objects', {}, mockApi);
    const data = parseResult(result);
    expect(data.wsdlVersion).toBe(AXL_OBJECTS_SOURCE_WSDL_VERSION);
    expect(data.objectCount).toBe(AXL_TOP_LEVEL_OBJECTS.length);
    expect(data.objects).toEqual([...AXL_TOP_LEVEL_OBJECTS]);
  });

  it('returns filtered objects when AXL_MCP_ENABLED_OBJECTS set', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone,User';
    process.argv = ['node', 'script.js'];
    const result = await handleTool('axl_list_objects', {}, mockApi);
    const data = parseResult(result);
    expect(data.objectCount).toBe(2);
    expect(data.objects).toContain('Phone');
    expect(data.objects).toContain('User');
    expect(data.objects).not.toContain('Line');
  });
});

describe('axl_list_operations', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns operations for valid object', async () => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    const result = await handleTool('axl_list_operations', { objectName: 'Phone' }, mockApi);
    const data = parseResult(result);
    expect(data.objectName).toBe('Phone');
    expect(data.operations).toBeDefined();
    expect(data.operations.add).toBe('addPhone');
    expect(data.operations.get).toBe('getPhone');
  });

  it('throws for unknown objectName', async () => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    await expect(
      handleTool('axl_list_operations', { objectName: 'BogusObject' }, mockApi)
    ).rejects.toThrow('Unknown objectName "BogusObject"');
  });

  it('throws when objectName is not in enabled set', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    process.argv = ['node', 'script.js'];
    await expect(
      handleTool('axl_list_operations', { objectName: 'User' }, mockApi)
    ).rejects.toThrow('Object "User" is not enabled');
  });
});

describe('axl_describe_operation with enabled_objects', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when operation parent object is disabled', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'User';
    process.argv = ['node', 'script.js'];
    await expect(
      handleTool('axl_describe_operation', { operationName: 'addPhone' }, mockApi)
    ).rejects.toThrow('Operation "addPhone" targets "Phone" which is not enabled');
  });

  it('allows operation when parent object is enabled', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    process.argv = ['node', 'script.js'];
    const result = await handleTool('axl_describe_operation', { operationName: 'addPhone' }, mockApi);
    const data = parseResult(result);
    expect(data.operationName).toBe('addPhone');
  });
});

describe('axl_execute edge cases', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('passes opts through to executeOperation', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
        opts: { clean: true, removeAttributes: true },
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({
      clean: true,
      removeAttributes: true,
      dataContainerIdentifierTails: undefined,
    });
  });

  it('passes dataContainerIdentifierTails opt', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
        opts: { dataContainerIdentifierTails: 'Return' },
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({
      clean: undefined,
      removeAttributes: undefined,
      dataContainerIdentifierTails: 'Return',
    });
  });

  it('throws when operation not mapped and enabled_objects is set', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'executeSQLQuery',
          data: { sql: 'SELECT 1' },
        },
        mockApi
      )
    ).rejects.toThrow('is not mapped to a top-level object');
  });

  it('throws when operation object is disabled', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'User';
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'addPhone',
          data: { phone: { name: 'SEP001122334455' } },
        },
        mockApi
      )
    ).rejects.toThrow('targets "Phone" which is not enabled');
  });

  it('converts executeOperation errors via toMcpError', async () => {
    const failingApi: AxlAPIService = {
      executeOperation: async () => {
        throw new Error('Something broke');
      },
    } as unknown as AxlAPIService;

    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
        },
        failingApi
      )
    ).rejects.toThrow('Something broke');
  });

  it('handles missing data gracefully (defaults to empty object)', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'getPhone',
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({});
  });
});
