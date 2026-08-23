import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CiscoAxlMcpServer } from '../src/index';
import { clearAxlClientCache } from '../src/lib/axl-client';
import { flushAuditLog } from '../src/lib/audit-log';
import type { ResolvedMcpConfig } from '../src/lib/tool-config';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';

const transportObservations = vi.hoisted(() => ({
  dispatches: 0,
  aborts: 0,
  requestOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('cisco-axl', () => ({
  default: class FakeCiscoAxlService {
    private readonly soapClient: {
      security: { addOptions?(options: Record<string, unknown>): void };
      setSecurity(security: { addOptions?(options: Record<string, unknown>): void }): void;
      httpClient: {
        _request(
          options: Record<string, unknown>,
          callback: (error?: Error | null) => void
        ): { abort(): void; once(): void };
      };
    };

    constructor() {
      this.soapClient = {
        security: {},
        setSecurity: security => {
          this.soapClient.security = security;
        },
        httpClient: {
          _request: (options, callback) => {
            transportObservations.requestOptions.push(options);
            return {
              abort: () => {
                transportObservations.aborts++;
                callback(new Error('fake SOAP request aborted'));
              },
              once: () => {},
            };
          },
        },
      };
    }

    _getClient = async () => this.soapClient;

    async executeOperation(): Promise<unknown> {
      const client = await this._getClient();
      const options: Record<string, unknown> = {};
      client.security.addOptions?.(options);
      transportObservations.dispatches++;
      return new Promise((_resolve, reject) => {
        client.httpClient._request(options, error => {
          if (error) reject(error);
        });
      });
    }

    async testAuthentication(): Promise<boolean> {
      return true;
    }
  },
}));

function testConfig(overrides: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig {
  return {
    tlsMode: 'secure',
    sqlEnabled: false,
    enabledObjects: new Set(['Phone']),
    allowGlobalActions: false,
    allowInlineCredentials: true,
    requestTimeoutMs: 30_000,
    clientCacheMaxEntries: 4,
    credentialProvider: null,
    fixedTarget: null,
    ...overrides,
  };
}

function request(operation: string, data: unknown) {
  return {
    method: 'tools/call',
    params: {
      name: 'axl_execute',
      arguments: {
        cucm_host: 'production-stack.test',
        cucm_username: 'admin',
        cucm_password: 'not-in-output',
        cucm_version: '14.0',
        operation,
        data,
      },
    },
  };
}

describe('registered MCP production cancellation stack', () => {
  beforeAll(async () => {
    await loadAxlVersionArtifacts('14.0');
  });

  afterEach(async () => {
    clearAxlClientCache();
    await flushAuditLog();
    transportObservations.dispatches = 0;
    transportObservations.aborts = 0;
    transportObservations.requestOptions.length = 0;
  });

  it('preserves mutation outcome-unknown policy code through real registered SOAP cancellation', async () => {
    const server = new CiscoAxlMcpServer(testConfig());
    const internal = server as unknown as {
      server: {
        _requestHandlers: Map<
          string,
          (request: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>
        >;
      };
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');
    const mutation = request('updatePhone', {
      name: 'SEP001122334455',
      description: 'approved',
    });

    try {
      const preview = (await call({
        method: 'tools/call',
        params: {
          name: 'axl_preview_mutation',
          arguments: mutation.params.arguments,
        },
      })) as CallToolResult;
      const content = preview.content[0];
      if (!content || content.type !== 'text') throw new Error('preview response missing text');
      const { mutationGrant } = JSON.parse(content.text) as { mutationGrant: unknown };
      const controller = new AbortController();
      const execute = call(
        {
          method: mutation.method,
          params: {
            ...mutation.params,
            arguments: { ...mutation.params.arguments, mutationGrant },
          },
        },
        { signal: controller.signal }
      );

      await vi.waitFor(() => expect(transportObservations.dispatches).toBe(1));
      controller.abort();

      await expect(execute).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        data: { policyCode: 'AXL_MUTATION_OUTCOME_UNKNOWN' },
      });
      expect(transportObservations.aborts).toBe(1);
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });

  it('preserves pre-dispatch read cancellation policy code and does not create SOAP work', async () => {
    const server = new CiscoAxlMcpServer(testConfig());
    const internal = server as unknown as {
      server: {
        _requestHandlers: Map<
          string,
          (request: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>
        >;
      };
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(
        call(request('getPhone', { name: 'SEP001122334455' }), { signal: controller.signal })
      ).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        data: { policyCode: 'AXL_REQUEST_CANCELLED' },
      });
      expect(transportObservations.dispatches).toBe(0);
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });

  it('preserves read-timeout policy code through the registered SOAP stack', async () => {
    const server = new CiscoAxlMcpServer(testConfig({ requestTimeoutMs: 10 }));
    const internal = server as unknown as {
      server: {
        _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
      };
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');

    try {
      await expect(call(request('getPhone', { name: 'SEP001122334455' }))).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        data: { policyCode: 'AXL_READ_TIMEOUT' },
      });
      expect(transportObservations.dispatches).toBe(1);
      expect(transportObservations.aborts).toBe(1);
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });
});
