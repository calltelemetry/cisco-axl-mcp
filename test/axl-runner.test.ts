import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  consumeMutationGrant,
  createMutationGrant,
  MutationGrantAuthority,
  MutationGrantReplayStore,
} from '../src/lib/mutation-grants';
import {
  previewAxlMutation,
  runAxl,
  type AxlRunRequest,
  type RunAxlOptions,
} from '../src/lib/axl-runner';
import type { AxlAPIService } from '../src/services/axl/index';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';

const PACKAGE_VERSION = '0.5.0-test';
const NOW = Date.parse('2026-08-12T18:00:00.000Z');

function request(overrides: Partial<AxlRunRequest> = {}): AxlRunRequest {
  return {
    credentials: {
      host: 'cucm-a.example.test',
      username: 'axl-admin',
      password: 'correct horse battery staple',
      version: '14.0',
    },
    tlsMode: 'secure',
    operation: 'getPhone',
    data: { name: 'SEP001122334455' },
    ...overrides,
  };
}

function service(result: unknown = { return: { phone: { name: 'SEP001122334455' } } }) {
  const executeOperation = vi.fn().mockResolvedValue(result);
  const listAll = vi.fn().mockResolvedValue(result);
  return {
    api: { executeOperation, listAll } as unknown as AxlAPIService,
    executeOperation,
    listAll,
  };
}

const strictRunOptions: RunAxlOptions = {
  request: request(),
  source: 'mcp',
  validationMode: 'strict',
};
void strictRunOptions;

const incompatibleRunOptions: RunAxlOptions = {
  request: request(),
  source: 'mcp',
  // @ts-expect-error compatible is not a supported runner validation mode
  validationMode: 'compatible',
};
void incompatibleRunOptions;

describe('runAxl policy separation', () => {
  beforeAll(async () => {
    await Promise.all([loadAxlVersionArtifacts('11.0'), loadAxlVersionArtifacts('15.0')]);
  });

  it.each([
    ['MCP', 'mcp', '11.0', { definitely_not_a_11_field: 'rejected' }],
    ['CLI', 'cli', '15.0', { definitely_not_a_15_field: 'rejected' }],
    ['MCP', 'mcp', '15.0', {}],
    ['CLI', 'cli', '11.0', { name: 42 }],
    ['MCP', 'mcp', '15.0', { name: 'SEP001122334455', returnedTags: { class: 'Router' } }],
    ['CLI', 'cli', '11.0', { name: 'SEP001122334455', uuid: 'bad-choice' }],
  ] as const)(
    'rejects schema-invalid %s operation input from %s before transport dispatch',
    async (_sourceLabel, source, version, data) => {
      const fake = service();

      await expect(
        runAxl(
          {
            request: request({ credentials: { ...request().credentials, version }, data }),
            source,
            validationMode: 'strict',
          },
          { service: fake.api, packageVersion: PACKAGE_VERSION }
        )
      ).rejects.toMatchObject({ code: 'AXL_OPERATION_INPUT_INVALID' });
      expect(fake.executeOperation).not.toHaveBeenCalled();
    }
  );

  it('rejects an untyped non-strict validation mode before transport dispatch', async () => {
    const fake = service({ raw: true });

    await expect(
      runAxl(
        { request: request(), source: 'mcp', validationMode: 'compatible' as never },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_POLICY_VALIDATION_MODE' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    ['source', { source: 'unknown-source', validationMode: 'strict' }, 'AXL_POLICY_SOURCE_INVALID'],
    [
      'validation mode',
      { source: 'mcp', validationMode: 'unknown-validation' },
      'AXL_POLICY_VALIDATION_MODE',
    ],
  ] as const)('runtime-rejects an unknown %s', async (_label, runtimeValues, code) => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request(),
          source: runtimeValues.source as 'mcp',
          validationMode: runtimeValues.validationMode as 'strict',
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('runtime-rejects an unknown TLS mode before transport dispatch', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({ tlsMode: 'unknown-tls' as 'secure' }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_TLS_MODE_INVALID' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects an unsupported CUCM version before loading schema artifacts', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({
            credentials: { ...request().credentials, version: '99.0' },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_UNSUPPORTED_VERSION' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects an object-valued operation without invoking coercion hooks', async () => {
    const fake = service();
    const toString = vi.fn(() => 'getPhone');
    const toJSON = vi.fn(() => 'getPhone');

    await expect(
      runAxl(
        {
          request: request({ operation: { toString, toJSON } as unknown as string }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_OPERATION_INVALID' });
    expect(toString).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects operations absent from the selected version catalog in strict mode', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({ operation: 'vendorRawOperationNotInGeneratedCatalog' }),
          source: 'cli',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_UNSUPPORTED_OPERATION' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  }, 15_000);

  it('allows strict read operations without a mutation grant', async () => {
    const fake = service();

    await expect(
      runAxl(
        { request: request(), source: 'workflow', validationMode: 'strict' },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).resolves.toBeDefined();
    expect(fake.executeOperation).toHaveBeenCalledOnce();
    expect(fake.executeOperation.mock.calls[0]![5]).toEqual({ mutationRetryMode: 'strict' });
  });

  it('passes strict execution policy to listAll outside SOAP request options', async () => {
    const fake = service({ rows: [], totalFetched: 0, pages: 1, truncated: false });
    const listRequest = request({
      operation: 'listPhone',
      data: { searchCriteria: { name: '%' }, returnedTags: {} },
      autoPage: true,
    });

    await expect(
      runAxl(
        { request: listRequest, source: 'cli', validationMode: 'strict' },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).resolves.toMatchObject({ totalFetched: 0 });

    expect(fake.listAll).toHaveBeenCalledWith(
      listRequest.credentials,
      listRequest.operation,
      listRequest.data,
      undefined,
      listRequest.tlsMode,
      { mutationRetryMode: 'strict' }
    );
  });

  it('recursively redacts sensitive response fields before returning them', async () => {
    const fake = service({
      return: {
        phone: {
          name: 'SEP001122334455',
          Password: 'response-password',
          nested: [{ api_token: 'response-token' }],
        },
      },
    });

    const result = await runAxl(
      { request: request(), source: 'mcp', validationMode: 'strict' },
      { service: fake.api, packageVersion: PACKAGE_VERSION }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('response-password');
    expect(serialized).not.toContain('response-token');
    expect(serialized).toContain('SEP001122334455');
  });

  it('preserves a getUser response wrapper while redacting nested credential aliases', async () => {
    const fake = service({
      return: {
        user: {
          userid: 'alice',
          firstName: 'Alice',
          username: 'directory-login',
          password: 'directory-password',
          nested: {
            user: 'nested-user-credential',
            authToken: 'directory-token',
          },
        },
      },
    });

    const result = await runAxl(
      {
        request: request({ operation: 'getUser', data: { userid: 'alice' } }),
        source: 'mcp',
        validationMode: 'strict',
      },
      { service: fake.api, packageVersion: PACKAGE_VERSION }
    );

    expect(result).toEqual({
      return: {
        user: {
          userid: 'alice',
          firstName: 'Alice',
          username: '***',
          password: '***',
          nested: {
            user: '***',
            authToken: '***',
          },
        },
      },
    });
  });

  it('redacts credentials from SOAP faults before exposing an error', async () => {
    const fault = new Error(
      'POST https://axl-admin:correct horse battery staple@cucm-a.example.test/axl failed'
    );
    Object.assign(fault, {
      faultDetail: {
        Password: 'correct horse battery staple',
        Authorization: 'Bearer response-token',
      },
    });
    const fake = service();
    fake.executeOperation.mockRejectedValue(fault);

    const exposed = await runAxl(
      { request: request(), source: 'mcp', validationMode: 'strict' },
      { service: fake.api, packageVersion: PACKAGE_VERSION }
    ).catch((error: unknown) => error);

    const serialized = JSON.stringify(exposed, Object.getOwnPropertyNames(exposed as object));
    expect(serialized).not.toContain('correct horse battery staple');
    expect(serialized).not.toContain('axl-admin');
    expect(serialized).not.toContain('response-token');
    expect(serialized).toContain('***');
  });

  it('requires a mutation grant for strict writes', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({
            operation: 'updatePhone',
            data: { name: 'SEP001122334455', description: 'new' },
          }),
          source: 'a2a',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('requires a grant for generated executeSQLQueryInactive before dispatch', async () => {
    const fake = service({ rows: [] });
    const readRequest = request({
      credentials: { ...request().credentials, version: '15.0' },
      operation: 'executeSQLQueryInactive',
      data: { sql: 'select name from device' },
    });

    await expect(
      runAxl(
        { request: readRequest, source: 'cli', validationMode: 'strict' },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  }, 30_000);

  it('rejects DML sent through executeSQLQueryInactive before service dispatch', async () => {
    const fake = service({ rows: [] });

    await expect(
      runAxl(
        {
          request: request({
            credentials: { ...request().credentials, version: '15.0' },
            operation: 'executeSQLQueryInactive',
            data: { sql: "DELETE FROM device WHERE name = 'SEP001122334455'" },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_SQL_QUERY_NOT_READ_ONLY' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    "DELETE FROM device WHERE name = 'SEP001122334455'",
    'CREATE TABLE unauthorized_write (id INTEGER)',
    'SELECT name FROM device; DELETE FROM device',
    '/* comment */ SELECT name FROM device',
    '{ Informix comment } SELECT name FROM device',
    'SELECT name FROM device { Informix comment }',
    'SELECT name { Informix comment } FROM device',
    'WITH devices AS (SELECT name FROM device) SELECT * FROM devices',
    'SELECT sequence_name.NEXTVAL FROM systables WHERE tabid = 1',
    'SELECT sequence_name.CURRVAL FROM systables WHERE tabid = 1',
    'SELECT dangerous_udr() FROM systables',
    'SELECT spl_mutation() FROM systables',
    'SELECT ABS(1) FROM systables',
    'SELECT (SELECT name FROM device) AS name FROM systables',
  ])('rejects unsafe executeSQLQuery text before dispatch: %s', async sql => {
    const fake = service({ rows: [] });

    await expect(
      runAxl(
        {
          request: request({ operation: 'executeSQLQuery', data: { sql } }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_SQL_QUERY_NOT_READ_ONLY' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    "SELECT name FROM v_device WHERE name = 'SEP001122334455'",
    "SELECT tabname FROM virtual_device WHERE tabname = 'device'",
  ])('requires a grant before a safe view or virtual-table query can dispatch: %s', async sql => {
    const fake = service({ rows: [] });

    await expect(
      runAxl(
        {
          request: request({ operation: 'executeSQLQuery', data: { sql } }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('requires a grant for an otherwise safe executeSQLQuery statement', async () => {
    const fake = service({ rows: [{ name: 'SEP001122334455' }] });

    await expect(
      runAxl(
        {
          request: request({
            operation: 'executeSQLQuery',
            data: { sql: "SELECT name FROM device WHERE name = 'SEP001122334455'" },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('allows comment-like and delimiter characters inside a benign SQL string literal', async () => {
    const fake = service({ rows: [{ label: 'benign' }] });

    await expect(
      runAxl(
        {
          request: request({
            operation: 'executeSQLQuery',
            data: { sql: "SELECT 'benign; -- { UPDATE }' AS label FROM device" },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    "SELECT name AS device_name FROM device WHERE name = 'SEP001122334455' ORDER BY name LIMIT 1",
    "SELECT 'benign literal' AS label FROM device WHERE name = 'SEP001122334455'",
    "SELECT d.name, d.description FROM device d WHERE d.name = 'SEP001122334455' ORDER BY d.name DESC LIMIT 5",
  ])('allows a simple read-only SQL query from the supported corpus: %s', async sql => {
    const fake = service({ rows: [{ name: 'SEP001122334455' }] });

    await expect(
      runAxl(
        {
          request: request({ operation: 'executeSQLQuery', data: { sql } }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('accepts a bound mutation grant for a safe executeSQLQuery request', async () => {
    const fake = service({ rows: [] });
    const readRequest = request({
      operation: 'executeSQLQuery',
      data: { sql: 'SELECT name FROM device' },
    });

    const mutationGrant = await createMutationGrant(
      {
        request: readRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW }
    );

    await expect(
      runAxl(
        {
          request: readRequest,
          source: 'mcp',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).resolves.toEqual({ rows: [] });
    expect(fake.executeOperation).toHaveBeenCalledOnce();
  });

  it('requires a mutation grant for executeSQLUpdate independent of SQL verb heuristics', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({
            operation: 'executeSQLUpdate',
            data: { sql: "UPDATE device SET description = 'approved'" },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each(['workflow', 'a2a'] as const)(
    'uses the selected version schema for mraServiceDomain from the %s runner source',
    async source => {
      const data = { name: 'Default', mraServiceDomain: 'mra.example.test' };
      const legacy = service();

      await expect(
        runAxl(
          {
            request: request({
              credentials: { ...request().credentials, version: '11.0' },
              operation: 'updateDevicePool',
              data,
            }),
            source,
            validationMode: 'strict',
          },
          { service: legacy.api, packageVersion: PACKAGE_VERSION, now: () => NOW }
        )
      ).rejects.toMatchObject({ code: 'AXL_OPERATION_INPUT_INVALID' });
      expect(legacy.executeOperation).not.toHaveBeenCalled();

      const currentRequest = request({
        credentials: { ...request().credentials, version: '15.0' },
        operation: 'updateDevicePool',
        data,
      });
      const mutationGrant = await createMutationGrant(
        {
          request: currentRequest,
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      );
      const current = service({ updated: true });

      await expect(
        runAxl(
          {
            request: currentRequest,
            source,
            validationMode: 'strict',
            mutationGrant,
          },
          {
            service: current.api,
            packageVersion: PACKAGE_VERSION,
            now: () => NOW,
            replayStore: new MutationGrantReplayStore(),
          }
        )
      ).resolves.toEqual({ updated: true });
      expect(current.executeOperation).toHaveBeenCalledOnce();
    }
  );
});

describe('mutation grant enforcement', () => {
  const writeRequest = request({
    operation: 'updatePhone',
    data: { name: 'SEP001122334455', description: 'approved' },
  });

  async function grant() {
    return createMutationGrant(
      {
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
        id: 'preview-123',
      },
      { now: () => NOW }
    );
  }

  it('rejects a read preview before minting a grant or dispatching transport', async () => {
    const fake = service();

    await expect(
      previewAxlMutation(
        { request: request(), source: 'mcp', validationMode: 'strict' },
        { service: fake.api, packageVersion: PACKAGE_VERSION, now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_NOT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects a preview cancelled after exact-version preparation', async () => {
    let checks = 0;
    const signal = {
      get aborted() {
        return checks++ > 0;
      },
    } as AbortSignal;

    await expect(
      previewAxlMutation(
        { request: writeRequest, source: 'mcp', validationMode: 'strict', signal },
        { packageVersion: PACKAGE_VERSION, now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_REQUEST_CANCELLED' });
    expect(checks).toBe(2);
  });

  it('rejects a mutation grant supplied for a read operation', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request(),
          source: 'mcp',
          validationMode: 'strict',
          mutationGrant: await grant(),
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_NOT_REQUIRED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects an invalid mutation preview before minting a grant or dispatching transport', async () => {
    const fake = service();

    await expect(
      previewAxlMutation(
        {
          request: request({
            operation: 'updatePhone',
            data: { name: 'SEP001122334455', unknown: 'not-in-schema' },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION, now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_OPERATION_INPUT_INVALID' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('honors a pre-cancelled preview without minting a grant or dispatching transport', async () => {
    const fake = service();
    const controller = new AbortController();
    controller.abort();

    await expect(
      previewAxlMutation(
        {
          request: writeRequest,
          source: 'mcp',
          validationMode: 'strict',
          signal: controller.signal,
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION, now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_REQUEST_CANCELLED' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('issues an authenticated provenance value', async () => {
    await expect(grant()).resolves.toMatchObject({
      provenance: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('applies an authenticated grant with an injected authority and replay store', async () => {
    const fake = service({ updated: true });
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 7));
    const mutationGrant = await createMutationGrant(
      {
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW, authority }
    );

    await expect(
      runAxl(
        {
          request: writeRequest,
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          grantAuthority: authority,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).resolves.toEqual({ updated: true });
  });

  it.each([
    [
      'id',
      (mutationGrant: Awaited<ReturnType<typeof grant>>) => ({ ...mutationGrant, id: 'forged-id' }),
    ],
    [
      'request digest',
      (mutationGrant: Awaited<ReturnType<typeof grant>>) => ({
        ...mutationGrant,
        requestDigest: '0'.repeat(64),
      }),
    ],
  ] as const)('rejects a grant with a caller-forged %s', async (_field, forge) => {
    const fake = service();
    const mutationGrant = forge(await grant());

    await expect(
      runAxl(
        {
          request: writeRequest,
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_PROVENANCE_INVALID' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects an object-valued grant id without invoking hooks or consuming replay state', async () => {
    const fake = service();
    const replayStore = new MutationGrantReplayStore();
    const consume = vi.spyOn(replayStore, 'consume');
    const toJSON = vi.fn(() => 'preview-123');
    const mutationGrant = {
      ...(await grant()),
      id: { toJSON },
    } as unknown as Awaited<ReturnType<typeof grant>>;

    await expect(
      runAxl(
        {
          request: writeRequest,
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore,
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_INVALID' });
    expect(toJSON).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects an object-valued grant id before HMAC signing without invoking hooks', async () => {
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 7));
    const { provenance: _provenance, ...unsignedGrant } = await createMutationGrant(
      {
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW, authority }
    );
    const toJSON = vi.fn(() => 'preview-123');

    expect(() => authority.sign({ ...unsignedGrant, id: { toJSON } } as never)).toThrowError(
      expect.objectContaining({ code: 'AXL_MUTATION_GRANT_INVALID' })
    );
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    ['id', { id: 42 }],
    ['issued timestamp', { issuedAt: 'not-a-timestamp' }],
    ['expiry timestamp', { expiresAt: '2026-08-12' }],
    ['target object', { target: [] }],
    ['target host', { target: { host: '', version: '14.0' } }],
    ['target version', { target: { host: 'cucm-a.example.test', version: 'fourteen' } }],
    ['operation', { operation: '' }],
    ['request digest', { requestDigest: 'not-a-digest' }],
    ['schema digest', { schemaDigest: 'not-a-digest' }],
    ['package version', { packageVersion: {} }],
    ['provenance', { provenance: 'not-a-mac' }],
  ] as const)('rejects malformed grant %s before replay consumption', async (_field, mutation) => {
    const replayStore = new MutationGrantReplayStore();
    const consume = vi.spyOn(replayStore, 'consume');
    const mutationGrant = {
      ...(await grant()),
      ...mutation,
    } as unknown as Awaited<ReturnType<typeof grant>>;

    expect(() =>
      consumeMutationGrant({
        grant: mutationGrant,
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        schemaDigest: mutationGrant.schemaDigest,
        now: () => NOW,
        replayStore,
      })
    ).toThrowError(expect.objectContaining({ code: 'AXL_MUTATION_GRANT_INVALID' }));
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects a grant applied to a different target', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: request({
            ...writeRequest,
            credentials: { ...writeRequest.credentials, host: 'cucm-b.example.test' },
          }),
          source: 'cli',
          validationMode: 'strict',
          mutationGrant: await grant(),
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_TARGET_DRIFT' });
  });

  it('binds grants to the exact transport principal without exposing credentials', async () => {
    const fake = service();
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 11));
    const mutationGrant = await createMutationGrant(
      {
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW, authority }
    );

    expect(JSON.stringify(mutationGrant)).not.toContain('cucm-a.example.test');
    expect(JSON.stringify(mutationGrant)).not.toContain('axl-admin');
    expect(JSON.stringify(mutationGrant)).not.toContain('correct horse battery staple');
    await expect(
      runAxl(
        {
          request: {
            ...writeRequest,
            credentials: { ...writeRequest.credentials, username: 'different-admin' },
          },
          source: 'mcp',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          grantAuthority: authority,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_TARGET_DRIFT' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each(['AXL-ADMIN', ' axl-admin', 'axl-admin '])(
    'rejects case or whitespace principal drift before dispatch: %s',
    async username => {
      const fake = service();
      const authority = new MutationGrantAuthority(Buffer.alloc(32, 13));
      const mutationGrant = await createMutationGrant(
        {
          request: writeRequest,
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW, authority }
      );

      await expect(
        runAxl(
          {
            request: {
              ...writeRequest,
              credentials: { ...writeRequest.credentials, username },
            },
            source: 'mcp',
            validationMode: 'strict',
            mutationGrant,
          },
          {
            service: fake.api,
            packageVersion: PACKAGE_VERSION,
            now: () => NOW,
            grantAuthority: authority,
            replayStore: new MutationGrantReplayStore(),
          }
        )
      ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_TARGET_DRIFT' });
      expect(fake.executeOperation).not.toHaveBeenCalled();
    }
  );

  it('allows password rotation for the same exact principal', async () => {
    const fake = service({ updated: true });
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 12));
    const mutationGrant = await createMutationGrant(
      {
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW, authority }
    );

    await expect(
      runAxl(
        {
          request: {
            ...writeRequest,
            credentials: {
              ...writeRequest.credentials,
              password: 'rotated-password',
            },
          },
          source: 'mcp',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          grantAuthority: authority,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).resolves.toEqual({ updated: true });
  });

  it('prunes expired replay entries and fails closed at its fixed capacity', () => {
    let now = NOW;
    const store = new MutationGrantReplayStore(2);
    expect(store.consume('expired-a', now + 1, now)).toBe(true);
    expect(store.consume('expired-b', now + 1, now)).toBe(true);
    now += 2;
    expect(store.consume('current-a', now + 60_000, now)).toBe(true);
    expect(store.size).toBe(1);
    expect(store.consume('current-b', now + 60_000, now)).toBe(true);
    expect(() => store.consume('overflow', now + 60_000, now)).toThrowError(
      expect.objectContaining({ code: 'AXL_MUTATION_GRANT_REPLAY_CAPACITY' })
    );
    expect(store.size).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
  });

  it('keeps replay memory bounded under a fake-clock high-volume expired-grant stream', () => {
    let now = NOW;
    const store = new MutationGrantReplayStore(8);
    for (let index = 0; index < 5_000; index++) {
      expect(store.consume(`grant-${index}`, now + 1, now)).toBe(true);
      now += 2;
    }
    expect(store.size).toBe(1);
  });

  it('rejects an expired preview grant', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: writeRequest,
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant: await grant(),
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW + 60_001,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_EXPIRED' });
  });

  it('rejects payload drift between preview and apply', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: {
            ...writeRequest,
            data: { name: 'SEP001122334455', description: 'drifted' },
          },
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant: await grant(),
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_DRIFT' });
  });

  it('rejects execute options drift between preview and apply', async () => {
    const fake = service();
    const previewRequest = { ...writeRequest, opts: { clean: true, removeAttributes: false } };
    const mutationGrant = await createMutationGrant(
      {
        request: previewRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW }
    );

    await expect(
      runAxl(
        {
          request: { ...previewRequest, opts: { clean: false, removeAttributes: false } },
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_DRIFT' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it('rejects TLS drift between preview and apply', async () => {
    const fake = service();
    const mutationGrant = await grant();

    await expect(
      runAxl(
        {
          request: { ...writeRequest, tlsMode: 'insecure' },
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant,
        },
        {
          service: fake.api,
          packageVersion: PACKAGE_VERSION,
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_DRIFT' });
    expect(fake.executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'custom toJSON',
      { name: 'SEP001122334455', toJSON: () => ({ name: 'forged-transport-value' }) },
    ],
    ['non-finite number', { name: 'SEP001122334455', value: Number.NaN }],
    ['undefined', { name: 'SEP001122334455', value: undefined }],
    ['bigint', { name: 'SEP001122334455', value: BigInt(1) }],
    ['date object', { name: 'SEP001122334455', value: new Date('2026-08-12T00:00:00Z') }],
  ] as const)('rejects mutation data containing %s', async (_label, data) => {
    await expect(
      createMutationGrant(
        {
          request: { ...writeRequest, data },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_INVALID' });
  });

  it('rejects an object-valued mutation operation without invoking coercion hooks', async () => {
    const toString = vi.fn(() => 'updatePhone');
    const toJSON = vi.fn(() => 'updatePhone');

    await expect(
      createMutationGrant(
        {
          request: {
            ...writeRequest,
            operation: { toString, toJSON } as unknown as string,
          },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_OPERATION_INVALID' });
    expect(toString).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('rejects cyclic mutation data', async () => {
    const data: Record<string, unknown> = { name: 'SEP001122334455' };
    data.self = data;

    await expect(
      createMutationGrant(
        {
          request: { ...writeRequest, data },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_INVALID' });
  });

  it('rejects array accessors without invoking them', async () => {
    let invoked = false;
    const values: unknown[] = [];
    Object.defineProperty(values, '0', {
      enumerable: true,
      get() {
        invoked = true;
        return 'side effect';
      },
    });
    values.length = 1;

    await expect(
      createMutationGrant(
        {
          request: { ...writeRequest, data: { name: 'SEP001122334455', values } },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_INVALID' });
    expect(invoked).toBe(false);
  });

  it('rejects arrays with a non-enumerable custom toJSON method', async () => {
    const values = ['original'];
    Object.defineProperty(values, 'toJSON', {
      value: () => ['forged-transport-value'],
    });

    await expect(
      createMutationGrant(
        {
          request: { ...writeRequest, data: { name: 'SEP001122334455', values } },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_INVALID' });
  });

  it('rejects non-JSON execute options', async () => {
    const opts = {
      clean: true,
      toJSON: () => ({ clean: false }),
    } as unknown as NonNullable<AxlRunRequest['opts']>;

    await expect(
      createMutationGrant(
        {
          request: { ...writeRequest, opts },
          packageVersion: PACKAGE_VERSION,
          expiresAt: new Date(NOW + 60_000).toISOString(),
        },
        { now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_REQUEST_INVALID' });
  });

  it('dispatches the same immutable normalized snapshot used for grant binding', async () => {
    const fake = service({ updated: true });
    const data = {
      newName: 'SEP001122334456',
      description: 'approved',
      name: 'SEP001122334455',
    };
    const opts = { removeAttributes: false, clean: true };
    const previewRequest = { ...writeRequest, data, opts };
    const mutationGrant = await createMutationGrant(
      {
        request: previewRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW }
    );

    await runAxl(
      {
        request: previewRequest,
        source: 'workflow',
        validationMode: 'strict',
        mutationGrant,
      },
      {
        service: fake.api,
        packageVersion: PACKAGE_VERSION,
        now: () => NOW,
        replayStore: new MutationGrantReplayStore(),
      }
    );

    const dispatchedData = fake.executeOperation.mock.calls[0]![2];
    const dispatchedOptions = fake.executeOperation.mock.calls[0]![3];
    expect(JSON.stringify(dispatchedData)).toBe(
      '{"description":"approved","name":"SEP001122334455","newName":"SEP001122334456"}'
    );
    expect(JSON.stringify(dispatchedOptions)).toBe('{"clean":true,"removeAttributes":false}');
    expect(dispatchedData).not.toBe(data);
    expect(dispatchedOptions).not.toBe(opts);
    expect(Object.isFrozen(dispatchedData)).toBe(true);
    expect(Object.isFrozen(dispatchedOptions)).toBe(true);
  });

  it('dispatches the approved snapshot when the original operation and data mutate after apply starts', async () => {
    const fake = service({ updated: true });
    const data = { name: 'SEP001122334455', description: 'approved' };
    const applyRequest = { ...writeRequest, data };
    const mutationGrant = await createMutationGrant(
      {
        request: applyRequest,
        packageVersion: PACKAGE_VERSION,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      { now: () => NOW }
    );

    const execution = runAxl(
      {
        request: applyRequest,
        source: 'workflow',
        validationMode: 'strict',
        mutationGrant,
      },
      {
        service: fake.api,
        packageVersion: PACKAGE_VERSION,
        now: () => NOW,
        replayStore: new MutationGrantReplayStore(),
      }
    );
    applyRequest.operation = 'removePhone';
    data.name = 'MUTATED';
    data.description = 'mutated';

    await expect(execution).resolves.toEqual({ updated: true });
    expect(fake.executeOperation).toHaveBeenCalledWith(
      expect.anything(),
      'updatePhone',
      { name: 'SEP001122334455', description: 'approved' },
      undefined,
      'secure',
      { mutationRetryMode: 'strict' }
    );
  });

  it('rejects package drift between preview and apply', async () => {
    const fake = service();

    await expect(
      runAxl(
        {
          request: writeRequest,
          source: 'workflow',
          validationMode: 'strict',
          mutationGrant: await grant(),
        },
        {
          service: fake.api,
          packageVersion: '0.5.1-test',
          now: () => NOW,
          replayStore: new MutationGrantReplayStore(),
        }
      )
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_PACKAGE_DRIFT' });
  });

  it('rejects schema drift between preview and apply', async () => {
    let thrown: unknown;
    try {
      consumeMutationGrant({
        grant: await grant(),
        request: writeRequest,
        packageVersion: PACKAGE_VERSION,
        schemaDigest: 'different-runtime-schema',
        now: () => NOW,
        replayStore: new MutationGrantReplayStore(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'AXL_MUTATION_GRANT_SCHEMA_DRIFT' });
  });

  it('consumes a grant before execution and rejects replay', async () => {
    const fake = service({ updated: true });
    const replayStore = new MutationGrantReplayStore();
    const mutationGrant = await grant();
    const options = {
      request: writeRequest,
      source: 'cli' as const,
      validationMode: 'strict' as const,
      mutationGrant,
    };
    const dependencies = {
      service: fake.api,
      packageVersion: PACKAGE_VERSION,
      now: () => NOW,
      replayStore,
    };

    await expect(runAxl(options, dependencies)).resolves.toEqual({ updated: true });
    await expect(runAxl(options, dependencies)).rejects.toMatchObject({
      code: 'AXL_MUTATION_GRANT_REPLAYED',
    });
    expect(fake.executeOperation).toHaveBeenCalledOnce();
    expect(fake.executeOperation.mock.calls[0]![5]).toEqual({ mutationRetryMode: 'strict' });
  });

  it('threads a caller cancellation signal to the service without changing the no-signal policy', async () => {
    const fake = service();
    const controller = new AbortController();

    await runAxl(
      {
        request: request(),
        source: 'mcp',
        validationMode: 'strict',
        signal: controller.signal,
      },
      { service: fake.api, packageVersion: PACKAGE_VERSION }
    );

    expect(fake.executeOperation.mock.calls[0]![5]).toEqual({
      mutationRetryMode: 'strict',
      shutdownSignal: controller.signal,
    });
  });

  it('rejects a CUCM 15-only operation for 11.0 but dispatches it for 15.0', async () => {
    const old = service();
    await expect(
      runAxl(
        {
          request: request({
            credentials: { ...request().credentials, version: '11.0' },
            operation: 'getCustomer',
            data: { name: 'customer-a' },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: old.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_UNSUPPORTED_OPERATION' });
    expect(old.executeOperation).not.toHaveBeenCalled();

    const current = service();
    await expect(
      runAxl(
        {
          request: request({
            credentials: { ...request().credentials, version: '15.0' },
            operation: 'getCustomer',
            data: { name: 'customer-a' },
          }),
          source: 'mcp',
          validationMode: 'strict',
        },
        { service: current.api, packageVersion: PACKAGE_VERSION }
      )
    ).resolves.toEqual(expect.anything());
    expect(current.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ version: '15.0' }),
      'getCustomer',
      { name: 'customer-a' },
      undefined,
      'secure',
      expect.anything()
    );
  });
});
