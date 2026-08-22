import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleTool } from '../src/tools/index';
import type { AxlRunner } from '../src/tools/types';
import type { RunAxlOptions } from '../src/lib/axl-runner';
import {
  AXL_OBJECTS_SOURCE_WSDL_VERSION,
  AXL_ACTION_OPERATIONS,
} from '../src/types/generated/axl-objects';
import type { ResolvedMcpConfig } from '../src/lib/tool-config';

// These legacy execution-path tests intentionally exercise the deprecated
// compatibility contract. Secure-by-default coverage lives in credentials and
// MCP conformance tests with allowInlineCredentials set to false.
beforeEach(() => {
  process.env.AXL_MCP_ALLOW_INLINE_CREDENTIALS = 'true';
});

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

function createCapturingMock() {
  const calls: RunAxlOptions[] = [];
  const api: AxlRunner = {
    runAxl: async (options: RunAxlOptions) => {
      calls.push(options);
      return { ok: true };
    },
  };
  return { api, calls };
}

const mockApi: AxlRunner = { runAxl: async () => ({ ok: true }) };

function testConfig(overrides: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig {
  return {
    tlsMode: 'secure',
    sqlEnabled: false,
    enabledObjects: new Set(),
    allowGlobalActions: false,
    allowInlineCredentials: true,
    requestTimeoutMs: 30_000,
    clientCacheMaxEntries: 16,
    ...overrides,
  };
}

describe('MCP execution policy boundary', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('routes an MCP read through strict exact-version runner validation', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    const calls: unknown[] = [];
    const runner = {
      runAxl: async (options: unknown) => {
        calls.push(options);
        return { return: { phone: { name: 'SEP001122334455' } } };
      },
    } as unknown as AxlRunner;

    const result = await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
      },
      runner
    );

    expect(parseResult(result)).toEqual({ return: { phone: { name: 'SEP001122334455' } } });
    expect(calls).toEqual([
      {
        source: 'mcp',
        validationMode: 'strict',
        request: {
          credentials: {
            host: 'test.local',
            username: 'user',
            password: 'pass',
            version: '14.0',
          },
          tlsMode: 'secure',
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
          autoPage: false,
        },
      },
    ]);
  });

  it('passes SQL query text to the strict runner policy boundary', async () => {
    process.env.AXL_MCP_ENABLE_SQL = 'true';
    const calls: RunAxlOptions[] = [];
    const runner: AxlRunner = {
      runAxl: async options => {
        calls.push(options);
        return { rows: [] };
      },
    };

    await handleTool(
      'axl_sql_query',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        sql: "DELETE FROM device WHERE name = 'SEP001122334455'",
      },
      runner
    );
    expect(calls).toEqual([
      expect.objectContaining({
        source: 'mcp',
        validationMode: 'strict',
        request: expect.objectContaining({ operation: 'executeSQLQuery' }),
      }),
    ]);
  });

  it('passes SQL updates to the strict runner with the request-bound mutation grant', async () => {
    process.env.AXL_MCP_ENABLE_SQL = 'true';
    const grant = { id: 'approval-id' };
    const calls: unknown[] = [];
    const runner = {
      runAxl: async (options: unknown) => {
        calls.push(options);
        return { rowsUpdated: 1 };
      },
    } as unknown as AxlRunner;

    await handleTool(
      'axl_sql_update',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        sql: "UPDATE device SET description = 'approved' WHERE name = 'SEP001122334455'",
        mutationGrant: grant,
      },
      runner
    );

    expect(calls).toEqual([
      expect.objectContaining({
        source: 'mcp',
        validationMode: 'strict',
        mutationGrant: grant,
        request: expect.objectContaining({
          operation: 'executeSQLUpdate',
          data: {
            sql: "UPDATE device SET description = 'approved' WHERE name = 'SEP001122334455'",
          },
        }),
      }),
    ]);
  });
});

describe('axl_list_objects', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CUCM_VERSION = '15.0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns no objects when no enabled_objects set', async () => {
    delete process.env.AXL_MCP_ENABLED_OBJECTS;
    delete process.env.AXL_MCP_CONFIG;
    const result = await handleTool('axl_list_objects', {}, mockApi);
    const data = parseResult(result);
    expect(data.wsdlVersion).toBe(AXL_OBJECTS_SOURCE_WSDL_VERSION);
    expect(data.objectCount).toBe(0);
    expect(data.objects).toEqual([]);
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

  beforeEach(() => {
    process.env.CUCM_VERSION = '15.0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns operations for valid object', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
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
    process.env.AXL_MCP_ENABLED_OBJECTS = 'all';
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

  it('does not leak CUCM 15 operations into the selected 11.0 catalog', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'all';

    await expect(
      handleTool('axl_list_operations', { cucm_version: '11.0', objectName: 'Customer' }, mockApi)
    ).rejects.toThrow('Unknown objectName "Customer"');

    const result = await handleTool(
      'axl_list_operations',
      { cucm_version: '15.0', objectName: 'Customer' },
      mockApi
    );
    const data = parseResult(result);
    expect(data.wsdlVersion).toBe('15.0');
    expect(data.operations.get).toBe('getCustomer');
  });

  it('defaults discovery to CUCM_VERSION and rejects unsupported versions before loading', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'all';
    process.env.CUCM_VERSION = '11.0';

    const result = await handleTool('axl_list_objects', {}, mockApi);
    expect(parseResult(result).wsdlVersion).toBe('11.0');

    await expect(handleTool('axl_list_objects', { cucm_version: '99.0' }, mockApi)).rejects.toThrow(
      'Unsupported cucm_version "99.0"'
    );
  });
});

describe('axl_describe_operation with enabled_objects', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CUCM_VERSION = '15.0';
  });

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
    const result = await handleTool(
      'axl_describe_operation',
      { operationName: 'addPhone' },
      mockApi
    );
    const data = parseResult(result);
    expect(data.operationName).toBe('addPhone');
  });
});

describe('axl_execute edge cases', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
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
    expect(calls[0]!.request.opts).toEqual({
      clean: true,
      removeAttributes: true,
      dataContainerIdentifierTails: undefined,
    });
  });

  it('rejects an unsupported execution version before invoking the runner', async () => {
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '99.0',
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
        },
        mockApi
      )
    ).rejects.toThrow('Unsupported cucm_version "99.0"');
  });

  it('rejects an operation absent from the selected version catalog', async () => {
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'vendorRawOperationNotInGeneratedCatalog',
          data: {},
        },
        mockApi
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_OPERATION_UNAVAILABLE' } });
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
    expect(calls[0]!.request.opts).toEqual({
      clean: undefined,
      removeAttributes: undefined,
      dataContainerIdentifierTails: 'Return',
    });
  });

  it('rejects object-less operations through generic execution', async () => {
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
    ).rejects.toThrow('is unavailable through axl_execute');
  });

  it('allows global action operations only with the explicit capability', async () => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    process.env.AXL_MCP_ALLOW_GLOBAL_ACTIONS = 'true';
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
    expect(calls[0]!.request.operation).toBe('doDeviceReset');
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
    expect(calls[0]!.request.operation).toBe('resetPhone');
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
    const api: AxlRunner = {
      runAxl: async () => ({
        rows: [{ name: 'a' }, { name: 'b' }],
        totalFetched: 2,
        pages: 1,
        truncated: false,
      }),
    };

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

  it('passes autoPage through to the runner for policy validation', async () => {
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
        autoPage: true,
      },
      api
    );
    expect(calls[0]!.request.autoPage).toBe(true);
  });

  it('converts executeOperation errors via toMcpError', async () => {
    const failingApi: AxlRunner = {
      runAxl: async () => {
        throw new Error('Something broke');
      },
    };

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
    expect(calls[0]!.request.data).toEqual({});
  });
});

describe('axl_preview_mutation edge cases', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    delete process.env.AXL_MCP_CONFIG;
    delete process.env.AXL_MCP_ENABLE_SQL;
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const mutation = {
    cucm_host: 'test.local',
    cucm_username: 'user',
    cucm_password: 'pass',
    cucm_version: '14.0',
    operation: 'updatePhone',
    data: { name: 'SEP001122334455', description: 'approved' },
  };

  it('rejects an unsupported preview version before loading schema artifacts', async () => {
    await expect(
      handleTool('axl_preview_mutation', { ...mutation, cucm_version: '99.0' }, mockApi)
    ).rejects.toThrow('Unsupported cucm_version "99.0"');
  });

  it('rejects SQL preview when the explicit SQL capability is disabled', async () => {
    await expect(
      handleTool(
        'axl_preview_mutation',
        { ...mutation, operation: 'executeSQLQuery', data: { sql: 'SELECT name FROM device' } },
        mockApi
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_SQL_DISABLED' } });
  });

  it('fails closed when the runner cannot provide mutation preview', async () => {
    await expect(handleTool('axl_preview_mutation', mutation, mockApi)).rejects.toMatchObject({
      data: { policyCode: 'AXL_MUTATION_PREVIEW_UNAVAILABLE' },
    });
  });
});

describe('axl_sql_query', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AXL_MCP_ENABLE_SQL = 'true';
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
    expect(calls[0]!.request.operation).toBe('executeSQLQuery');
    expect(calls[0]!.request.data).toEqual({ sql: 'SELECT name FROM device' });
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
    process.env.AXL_MCP_ENABLE_SQL = 'true';
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
    expect(calls[0]!.request.operation).toBe('executeSQLUpdate');
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
    process.env.AXL_MCP_ENABLED_OBJECTS = 'all';
    process.env.AXL_MCP_ALLOW_GLOBAL_ACTIONS = 'true';
    delete process.env.AXL_MCP_CONFIG;
    process.env.CUCM_VERSION = '15.0';
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
    const result = await handleTool(
      'axl_list_action_operations',
      { objectName: 'Line', verb: 'reset' },
      mockApi
    );
    const data = parseResult(result);
    expect(data.count).toBe(1);
    expect(data.operations).toHaveProperty('resetLine');
    expect(data.operations.resetLine).toEqual({ verb: 'reset', object: 'Line' });
  });

  it('returns empty when no match', async () => {
    const result = await handleTool(
      'axl_list_action_operations',
      { objectName: 'Css', verb: 'reset' },
      mockApi
    );
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

describe('effective MCP authorization', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CUCM_VERSION = '14.0';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the same object policy for list, describe, and execute', async () => {
    const config = testConfig({ enabledObjects: new Set(['Phone']) });
    const deniedObject = 'User';

    await expect(
      handleTool('axl_list_operations', { objectName: deniedObject }, mockApi, config)
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_OBJECT_DENIED' } });
    await expect(
      handleTool('axl_describe_operation', { operationName: 'getUser' }, mockApi, config)
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_OBJECT_DENIED' } });
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'getUser',
          data: { userid: 'disabled' },
        },
        mockApi,
        config
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_OBJECT_DENIED' } });
  });

  it('hides unauthorized object actions and requires explicit global-action permission', async () => {
    const config = testConfig({ enabledObjects: new Set(['Phone']) });
    const actions = parseResult(
      await handleTool('axl_list_action_operations', {}, mockApi, config)
    );

    expect(actions.operations).toHaveProperty('applyPhone');
    expect(actions.operations).not.toHaveProperty('resetUser');
    expect(actions.operations).not.toHaveProperty('doDeviceReset');
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_host: 'test.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'doDeviceReset',
          data: { name: 'SEP001122334455', isHardReset: false },
        },
        mockApi,
        config
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_GLOBAL_ACTION_DENIED' } });
  });

  it('allows explicit wildcard object and global-action capabilities', async () => {
    const config = testConfig({ enabledObjects: null, allowGlobalActions: true });
    const { api, calls } = createCapturingMock();

    const result = await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'doDeviceReset',
        data: { name: 'SEP001122334455', isHardReset: false },
      },
      api,
      config
    );

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns a stable policy code when SQL is disabled', async () => {
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
        mockApi,
        testConfig()
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_SQL_DISABLED' } });
  });
});
