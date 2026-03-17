import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleTool } from '../src/tools/index';
import type { AxlAPIService } from '../src/services/axl/index';
import { AXL_TOP_LEVEL_OBJECTS, AXL_OBJECTS_SOURCE_WSDL_VERSION, AXL_ACTION_OPERATIONS } from '../src/types/generated/axl-objects';

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
    // Action operations should also be included
    expect(data.operations.apply).toBe('applyPhone');
    expect(data.operations.reset).toBe('resetPhone');
    expect(data.operations.restart).toBe('restartPhone');
    expect(data.operations.lock).toBe('lockPhone');
    expect(data.operations.wipe).toBe('wipePhone');
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

  it('allows global action operations even when enabled_objects is set', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    const { api, calls } = createCapturingMock();
    // doDeviceReset has no specific object — it should be allowed regardless
    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'doDeviceReset',
        data: { name: 'SEP001122334455', isHardReset: false },
      },
      api
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe('doDeviceReset');
  });

  it('allows object-mapped action operations when object is enabled', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    const { api, calls } = createCapturingMock();
    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'resetPhone',
        data: { name: 'SEP001122334455' },
      },
      api
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe('resetPhone');
  });

  it('blocks object-mapped action operations when object is not enabled', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'User';
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'resetPhone',
          data: { name: 'SEP001122334455' },
        },
        mockApi
      )
    ).rejects.toThrow('targets "Phone" which is not enabled');
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

  it('autoPage delegates to listAll for list operations', async () => {
    const api: AxlAPIService = {
      executeOperation: async () => ({ ok: true }),
      listAll: async () => ({ rows: [{ name: 'a' }, { name: 'b' }], totalFetched: 2, pages: 1, truncated: false }),
    } as unknown as AxlAPIService;

    const result = await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'listPhone',
        data: { searchCriteria: { name: '%' } },
        autoPage: true,
      },
      api
    );
    const data = parseResult(result);
    expect(data.totalFetched).toBe(2);
    expect(data.rows).toHaveLength(2);
  });

  it('autoPage throws for non-list operations', async () => {
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
          autoPage: true,
        },
        mockApi
      )
    ).rejects.toThrow('autoPage is only valid for list operations');
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

describe('axl_sql_query', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AXL_MCP_ENABLE_SQL;
    delete process.env.AXL_MCP_CONFIG;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('executes SQL query via executeSQLQuery', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_sql_query',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        sql: 'SELECT name FROM device',
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe('executeSQLQuery');
    expect(calls[0]!.data).toEqual({ sql: 'SELECT name FROM device' });
  });

  it('throws when sql parameter is missing', async () => {
    await expect(
      handleTool(
        'axl_sql_query',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
        },
        mockApi
      )
    ).rejects.toThrow('Missing or invalid "sql"');
  });

  it('throws when SQL is disabled', async () => {
    process.env.AXL_MCP_ENABLE_SQL = 'false';
    await expect(
      handleTool(
        'axl_sql_query',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          sql: 'SELECT 1',
        },
        mockApi
      )
    ).rejects.toThrow('SQL operations are disabled');
  });
});

describe('axl_sql_update', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AXL_MCP_ENABLE_SQL;
    delete process.env.AXL_MCP_CONFIG;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('executes SQL update via executeSQLUpdate', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_sql_update',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        sql: 'UPDATE device SET description = "test" WHERE name = "SEP001122334455"',
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe('executeSQLUpdate');
  });

  it('throws when SQL is disabled', async () => {
    process.env.AXL_MCP_ENABLE_SQL = 'false';
    await expect(
      handleTool(
        'axl_sql_update',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          sql: 'DELETE FROM device WHERE name = "test"',
        },
        mockApi
      )
    ).rejects.toThrow('SQL operations are disabled');
  });
});

describe('axl_list_action_operations', () => {
  const originalEnv = { ...process.env };

  /** Shape of each entry in the operations map returned by axl_list_action_operations */
  type ActionOpInfo = { verb: string; object: string | null };

  beforeEach(() => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns all action operations when no filters', async () => {
    const result = await handleTool('axl_list_action_operations', {}, mockApi);
    const data = parseResult(result);
    expect(data.wsdlVersion).toBe(AXL_OBJECTS_SOURCE_WSDL_VERSION);
    expect(data.count).toBe(Object.keys(AXL_ACTION_OPERATIONS).length);
    expect(data.operations).toHaveProperty('doDeviceReset');
    expect(data.operations).toHaveProperty('applyPhone');
    expect(data.operations).toHaveProperty('resetPhone');
    expect(data.operations).toHaveProperty('restartPhone');
    expect(data.operations).toHaveProperty('lockPhone');
    expect(data.operations).toHaveProperty('wipePhone');
  });

  it('filters by objectName', async () => {
    const result = await handleTool('axl_list_action_operations', { objectName: 'Phone' }, mockApi);
    const data = parseResult(result);
    expect(data.count).toBeGreaterThan(0);
    // All returned operations should target Phone
    for (const info of Object.values(data.operations) as ActionOpInfo[]) {
      expect(info.object).toBe('Phone');
    }
    expect(data.operations).toHaveProperty('applyPhone');
    expect(data.operations).toHaveProperty('resetPhone');
    expect(data.operations).toHaveProperty('restartPhone');
    expect(data.operations).toHaveProperty('lockPhone');
    expect(data.operations).toHaveProperty('wipePhone');
    // doDeviceReset should not be included (it has no specific object)
    expect(data.operations).not.toHaveProperty('doDeviceReset');
  });

  it('filters by verb', async () => {
    const result = await handleTool('axl_list_action_operations', { verb: 'reset' }, mockApi);
    const data = parseResult(result);
    expect(data.count).toBeGreaterThan(0);
    // All returned operations should have verb 'reset'
    for (const [op, info] of Object.entries(data.operations) as Array<[string, ActionOpInfo]>) {
      expect(info.verb).toBe('reset');
      expect(op).toMatch(/^reset/);
    }
    expect(data.operations).toHaveProperty('resetPhone');
    expect(data.operations).not.toHaveProperty('applyPhone');
  });

  it('filters by objectName and verb together', async () => {
    const result = await handleTool('axl_list_action_operations', { objectName: 'Line', verb: 'reset' }, mockApi);
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.operations).toHaveProperty('resetLine');
    expect(data.operations.resetLine).toEqual({ verb: 'reset', object: 'Line' });
  });

  it('returns empty when no match', async () => {
    const result = await handleTool('axl_list_action_operations', { objectName: 'Css', verb: 'reset' }, mockApi);
    const data = parseResult(result);
    expect(data.count).toBe(0);
    expect(data.operations).toEqual({});
  });

  it('global action operations have null object', async () => {
    const result = await handleTool('axl_list_action_operations', { verb: 'do' }, mockApi);
    const data = parseResult(result);
    expect(data.count).toBeGreaterThan(0);
    for (const info of Object.values(data.operations) as ActionOpInfo[]) {
      expect(info.object).toBeNull();
    }
  });
});
