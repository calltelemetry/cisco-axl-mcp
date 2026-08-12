import { describe, expect, it, vi } from 'vitest';
import { createMutationGrant, MutationGrantReplayStore } from '../src/lib/mutation-grants';
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
    const fake = service();
    const mutationGrant = { ...(await grant()), schemaDigest: 'different-schema' };

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
    ).rejects.toMatchObject({ code: 'AXL_MUTATION_GRANT_SCHEMA_DRIFT' });
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
