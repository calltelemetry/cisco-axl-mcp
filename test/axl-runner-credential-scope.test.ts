import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const clientObservations = vi.hoisted(() => ({
  dispatchStarts: 0,
  nextOperationGate: undefined as Promise<void> | undefined,
}));

vi.mock('cisco-axl', () => ({
  default: class MockCiscoAxlService {
    constructor() {}

    async executeOperation(): Promise<{ ok: true }> {
      clientObservations.dispatchStarts++;
      const gate = clientObservations.nextOperationGate;
      clientObservations.nextOperationGate = undefined;
      if (gate) await gate;
      return { ok: true };
    }

    async testAuthentication(): Promise<boolean> {
      return true;
    }
  },
}));

import type { AxlAPIService } from '../src/services/axl/index';
import { createAxlRunner } from '../src/lib/axl-runner';
import {
  acquireAxlClientLease,
  clearAxlClientCache,
  getAxlClientCacheDiagnostics,
  retireAxlClientGeneration,
} from '../src/lib/axl-client';
import { CREDENTIAL_SCOPE, type CucmCredentials } from '../src/types/credentials';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';

describe('createAxlRunner provider credential scope integration', () => {
  beforeAll(async () => {
    await loadAxlVersionArtifacts('14.0');
  });

  beforeEach(() => {
    clearAxlClientCache();
    clientObservations.dispatchStarts = 0;
    clientObservations.nextOperationGate = undefined;
  });

  it('preserves provider scope so retirement rejects old admission and drains admitted work', async () => {
    const scope = Object.freeze({});
    const credentials = {
      host: 'cucm-provider.example.test',
      username: 'axl-admin',
      password: 'provider-password',
      version: '14.0',
      credentialGeneration: 1,
    } as CucmCredentials;
    Object.defineProperty(credentials, CREDENTIAL_SCOPE, {
      value: scope,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.freeze(credentials);

    let finishAdmittedWork!: () => void;
    clientObservations.nextOperationGate = new Promise<void>(resolve => {
      finishAdmittedWork = resolve;
    });

    let observedCredentials: CucmCredentials | undefined;
    const service = {
      executeOperation: async (admitted: CucmCredentials, operation: string, data: unknown) => {
        observedCredentials = admitted;
        const lease = acquireAxlClientLease(admitted);
        try {
          return await lease.client.executeOperation(operation, data);
        } finally {
          lease.release();
        }
      },
      listAll: vi.fn(),
    } as unknown as AxlAPIService;
    const runner = createAxlRunner({ service });
    const options = {
      request: {
        credentials,
        tlsMode: 'secure' as const,
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
      },
      source: 'mcp' as const,
      validationMode: 'strict' as const,
    };

    const admittedWork = runner.runAxl(options);
    await vi.waitFor(() => expect(clientObservations.dispatchStarts).toBe(1), { timeout: 5_000 });

    retireAxlClientGeneration(1, scope);
    const oldGenerationAdmission = runner.runAxl(options);

    finishAdmittedWork();
    await expect(admittedWork).resolves.toEqual({ ok: true });
    await expect(oldGenerationAdmission).rejects.toMatchObject({
      code: 'AXL_CREDENTIAL_GENERATION_RETIRED',
    });
    expect(observedCredentials?.[CREDENTIAL_SCOPE]).toBe(scope);
    expect(getAxlClientCacheDiagnostics()).toEqual({
      cachedClients: 0,
      activeRequests: 0,
      queuedRequests: 0,
    });
  });
});
