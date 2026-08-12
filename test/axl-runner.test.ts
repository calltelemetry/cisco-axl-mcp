import { describe, expect, it, vi } from 'vitest';
import {
  consumeMutationGrant,
  createMutationGrant,
  MutationGrantAuthority,
  MutationGrantReplayStore,
} from '../src/lib/mutation-grants';
import { runAxl, type AxlRunRequest } from '../src/lib/axl-runner';
import type { AxlAPIService } from '../src/services/axl/index';

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

describe('runAxl policy separation', () => {
  it('preserves compatible MCP raw operation dispatch without catalog or grant enforcement', async () => {
    const fake = service({ raw: true });
    const rawRequest = request({
      operation: 'vendorRawOperationNotInGeneratedCatalog',
      data: { vendorPayload: true },
      opts: { clean: false },
    });

    await expect(
      runAxl(
        { request: rawRequest, source: 'mcp', validationMode: 'compatible' },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).resolves.toEqual({ raw: true });

    expect(fake.executeOperation).toHaveBeenCalledWith(
      rawRequest.credentials,
      rawRequest.operation,
      rawRequest.data,
      rawRequest.opts,
      rawRequest.tlsMode
    );
  });

  it('rejects compatible validation for non-MCP callers so strict policy cannot be bypassed', async () => {
    const fake = service();

    await expect(
      runAxl(
        { request: request(), source: 'cli', validationMode: 'compatible' },
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
        { service: fake.api, packageVersion: PACKAGE_VERSION }
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
          validationMode: 'compatible',
        },
        { service: fake.api, packageVersion: PACKAGE_VERSION }
      )
    ).rejects.toMatchObject({ code: 'AXL_TLS_MODE_INVALID' });
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
      { request: request(), source: 'mcp', validationMode: 'compatible' },
      { service: fake.api, packageVersion: PACKAGE_VERSION }
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('response-password');
    expect(serialized).not.toContain('response-token');
    expect(serialized).toContain('SEP001122334455');
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
      { request: request(), source: 'mcp', validationMode: 'compatible' },
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
      z: 1,
      nested: { z: 2, a: 1 },
      a: 'first',
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
    expect(JSON.stringify(dispatchedData)).toBe('{"a":"first","nested":{"a":1,"z":2},"z":1}');
    expect(JSON.stringify(dispatchedOptions)).toBe('{"clean":true,"removeAttributes":false}');
    expect(dispatchedData).not.toBe(data);
    expect(dispatchedOptions).not.toBe(opts);
    expect(Object.isFrozen(dispatchedData)).toBe(true);
    expect(Object.isFrozen((dispatchedData as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(dispatchedOptions)).toBe(true);
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
  });
});
