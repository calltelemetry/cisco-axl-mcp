import { ErrorCode, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTools, handleTool } from '../src/tools/index';
import type { AxlRunner } from '../src/tools/types';
import type { ResolvedMcpConfig } from '../src/lib/tool-config';
import { CiscoAxlMcpServer, startMcp } from '../src/index';
import type { CredentialSnapshot, CredentialSource } from '../src/lib/credential-source';
import type { AxlToolRuntime } from '../src/lib/credential-resolver';
import { createAxlRunner } from '../src/lib/axl-runner';
import { MutationGrantAuthority, MutationGrantReplayStore } from '../src/lib/mutation-grants';
import { AxlAPIService, STRICT_AXL_EXECUTION_POLICY } from '../src/services/axl/index';
import { AxlPolicyError } from '../src/types/axl/errors';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';
import {
  auditLogPathForHost,
  flushAuditLog,
  getAuditDir,
  recordOperation,
  setAuditDir,
  writeAuditEntry,
} from '../src/lib/audit-log';

const createMockAxlAPI = (): AxlRunner => ({
  runAxl: async () => ({ ok: true }),
});

function testConfig(overrides: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig {
  return {
    tlsMode: 'secure',
    sqlEnabled: false,
    enabledObjects: new Set(),
    allowGlobalActions: false,
    allowInlineCredentials: false,
    requestTimeoutMs: 30_000,
    clientCacheMaxEntries: 16,
    credentialProvider: null,
    fixedTarget: null,
    ...overrides,
  };
}

describe('MCP Protocol Conformance', () => {
  // Keep generated schema loading out of the protocol assertions. Parallel
  // workers can otherwise spend their full assertion budget on the first
  // version-artifact import rather than the MCP behavior under test.
  beforeAll(async () => {
    await loadAxlVersionArtifacts('14.0');
  });

  function providerConfig(overrides: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig {
    return testConfig({
      credentialProvider: {
        argv: ['/opt/ct/bin/provider'],
        ttlMs: 30_000,
        maxStaleMs: 0,
        timeoutMs: 1_000,
        refreshOnSighup: true,
      },
      fixedTarget: { host: 'fixed.example.test', version: '11.5' },
      ...overrides,
    });
  }

  function source(
    events: string[],
    initialize: () => Promise<CredentialSnapshot>
  ): CredentialSource {
    return {
      initialize,
      current: () => ({
        material: { username: 'provider-user', password: 'provider-password' },
        generation: 1,
        resolvedAtMs: 1_000,
        expiresAtMs: 100_000,
        staleUntilMs: 100_000,
        identityDigest: 'digest',
      }),
      refresh: async trigger => {
        events.push(`refresh:${trigger}`);
        return {
          material: { username: 'provider-user', password: 'provider-password' },
          generation: 1,
          resolvedAtMs: 1_000,
          expiresAtMs: 100_000,
          staleUntilMs: 100_000,
          identityDigest: 'digest',
        };
      },
      shutdown: async () => {
        events.push('source:shutdown');
      },
    };
  }

  function runtime(credentialSource: CredentialSource): AxlToolRuntime {
    return {
      credentialSource,
      startupEnvironment: { CUCM_HOST: 'fixed.example.test', CUCM_VERSION: '11.5' },
      now: () => 1_500,
    };
  }

  it('initializes provider credentials before constructing and connecting the MCP server', async () => {
    const events: string[] = [];
    const credentialSource = source(events, async () => {
      events.push('source:initialize');
      return {
        material: { username: 'provider-user', password: 'provider-password' },
        generation: 1,
        resolvedAtMs: 1_000,
        expiresAtMs: 100_000,
        staleUntilMs: 100_000,
        identityDigest: 'digest',
      };
    });
    const run = vi.spyOn(CiscoAxlMcpServer.prototype, 'run').mockImplementation(async function () {
      events.push('server:connect');
    });

    try {
      await startMcp(
        providerConfig({
          credentialProvider: {
            argv: ['/opt/ct/bin/provider'],
            ttlMs: 30_000,
            maxStaleMs: 0,
            timeoutMs: 1_000,
            refreshOnSighup: false,
          },
        }),
        runtime(credentialSource)
      );
      expect(events.slice(0, 2)).toEqual(['source:initialize', 'server:connect']);
    } finally {
      run.mockRestore();
    }
  });

  it('does not construct or connect MCP when provider initialization fails', async () => {
    const credentialSource = source([], async () => {
      throw new Error('provider failed');
    });
    const construct = vi.spyOn(CiscoAxlMcpServer.prototype, 'run');

    await expect(startMcp(providerConfig(), runtime(credentialSource))).rejects.toThrow(
      'provider failed'
    );
    expect(construct).not.toHaveBeenCalled();
    construct.mockRestore();
  });

  it('cleans up initialized provider and listeners when startup run fails', async () => {
    const events: string[] = [];
    const credentialSource = source(events, async () => {
      events.push('source:initialize');
      return {
        material: { username: 'provider-user', password: 'provider-password' },
        generation: 1,
        resolvedAtMs: 1_000,
        expiresAtMs: 100_000,
        staleUntilMs: 100_000,
        identityDigest: 'digest',
      };
    });
    const beforeInt = new Set(process.listeners('SIGINT'));
    const beforeTerm = new Set(process.listeners('SIGTERM'));
    const beforeHup = new Set(process.listeners('SIGHUP'));
    const run = vi
      .spyOn(CiscoAxlMcpServer.prototype, 'run')
      .mockRejectedValue(new Error('stdio connect failed'));

    try {
      await expect(startMcp(providerConfig(), runtime(credentialSource))).rejects.toThrow(
        'stdio connect failed'
      );
      expect(events).toContain('source:shutdown');
      expect(process.listeners('SIGINT')).toEqual([...beforeInt]);
      expect(process.listeners('SIGTERM')).toEqual([...beforeTerm]);
      expect(process.listeners('SIGHUP')).toEqual([...beforeHup]);
    } finally {
      run.mockRestore();
      for (const listener of process.listeners('SIGINT')) {
        if (!beforeInt.has(listener)) process.off('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!beforeTerm.has(listener)) process.off('SIGTERM', listener);
      }
      for (const listener of process.listeners('SIGHUP')) {
        if (!beforeHup.has(listener)) process.off('SIGHUP', listener);
      }
    }
  });

  it('cleans up initialized provider when server construction fails', async () => {
    const events: string[] = [];
    const credentialSource = source(events, async () => {
      events.push('source:initialize');
      return {
        material: { username: 'provider-user', password: 'provider-password' },
        generation: 1,
        resolvedAtMs: 1_000,
        expiresAtMs: 100_000,
        staleUntilMs: 100_000,
        identityDigest: 'digest',
      };
    });
    const originalOn = process.on;
    const on = vi.spyOn(process, 'on').mockImplementation(function (...args) {
      if (args[0] === 'SIGINT') throw new Error('listener install failed');
      return originalOn.apply(process, args as Parameters<typeof process.on>);
    });

    try {
      await expect(startMcp(providerConfig(), runtime(credentialSource))).rejects.toThrow(
        'listener install failed'
      );
      expect(events).toContain('source:shutdown');
    } finally {
      on.mockRestore();
    }
  });

  it('shuts down credentials before waiting for the bounded AXL drain', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const credentialSource = source(events, async () => ({
      material: { username: 'provider-user', password: 'provider-password' },
      generation: 1,
      resolvedAtMs: 1_000,
      expiresAtMs: 100_000,
      staleUntilMs: 100_000,
      identityDigest: 'digest',
    }));
    const server = new CiscoAxlMcpServer(
      providerConfig({ enabledObjects: new Set(['Phone']) }),
      runtime(credentialSource)
    );
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: async () => {
        markStarted();
        return new Promise(() => undefined);
      },
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');

    const request = call({
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_version: '11.5',
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
        },
      },
    });
    const requestOutcome = request.catch(() => undefined);

    try {
      await vi.advanceTimersByTimeAsync(0);
      await started;
      const shutdown = server.shutdown();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toContain('source:shutdown');
      let settled = false;
      void shutdown.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(shutdown).rejects.toThrow('Shutdown incomplete');
    } finally {
      void requestOutcome;
      await server.shutdown().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('refreshes once for enabled SIGHUP and unregisters before source shutdown', async () => {
    const events: string[] = [];
    const credentialSource = source(events, async () => ({
      material: { username: 'provider-user', password: 'provider-password' },
      generation: 1,
      resolvedAtMs: 1_000,
      expiresAtMs: 100_000,
      staleUntilMs: 100_000,
      identityDigest: 'digest',
    }));
    const server = new CiscoAxlMcpServer(providerConfig(), runtime(credentialSource));
    try {
      process.emit('SIGHUP');
      process.emit('SIGHUP');
      await vi.waitFor(() =>
        expect(events.filter(event => event === 'refresh:sighup')).toHaveLength(1)
      );
      await server.shutdown();
      expect(events.at(-1)).toBe('source:shutdown');
      process.emit('SIGHUP');
      await new Promise(resolve => setImmediate(resolve));
      expect(events.filter(event => event === 'refresh:sighup')).toHaveLength(1);
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });

  it('mints a server-owned preview grant and rejects replay through MCP tool calls', async () => {
    const executeOperation = vi.fn().mockResolvedValue({ updated: true });
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 9));
    const replayStore = new MutationGrantReplayStore();
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    (server as unknown as { runner: AxlRunner }).runner = createAxlRunner({
      service: { executeOperation, listAll: vi.fn() } as unknown as AxlAPIService,
      grantAuthority: authority,
      replayStore,
    });
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');
    const mutation = {
      cucm_host: 'preview.cluster.test',
      cucm_username: 'preview-admin',
      cucm_password: 'never-in-a-grant',
      cucm_version: '14.0',
      operation: 'updatePhone',
      data: { name: 'SEP001122334455', description: 'approved' },
    };

    try {
      const preview = (await call({
        method: 'tools/call',
        params: { name: 'axl_preview_mutation', arguments: mutation },
      })) as CallToolResult;
      const content = preview.content[0];
      if (!content || content.type !== 'text') throw new Error('preview response missing text');
      const { mutationGrant } = JSON.parse(content.text) as {
        mutationGrant: Record<string, unknown>;
      };

      expect(mutationGrant).not.toHaveProperty('host');
      expect(mutationGrant).not.toHaveProperty('username');
      expect(mutationGrant).not.toHaveProperty('password');
      expect(mutationGrant.target).toEqual({
        endpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        principalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: '14.0',
      });
      expect(executeOperation).not.toHaveBeenCalled();

      await expect(
        call({
          method: 'tools/call',
          params: {
            name: 'axl_execute',
            arguments: { ...mutation, mutationGrant },
          },
        })
      ).resolves.toMatchObject({ content: expect.any(Array) });
      expect(executeOperation).toHaveBeenCalledOnce();

      await expect(
        call({
          method: 'tools/call',
          params: {
            name: 'axl_execute',
            arguments: { ...mutation, mutationGrant },
          },
        })
      ).rejects.toMatchObject({ data: { policyCode: 'AXL_MUTATION_GRANT_REPLAYED' } });
      expect(executeOperation).toHaveBeenCalledOnce();
    } finally {
      await server.shutdown();
    }
  });

  it('does not mint a preview grant when the registered MCP handler receives a cancelled SDK signal', async () => {
    const executeOperation = vi.fn();
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    (server as unknown as { runner: AxlRunner }).runner = createAxlRunner({
      service: { executeOperation, listAll: vi.fn() } as unknown as AxlAPIService,
    });
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
        call(
          {
            method: 'tools/call',
            params: {
              name: 'axl_preview_mutation',
              arguments: {
                cucm_host: 'cancelled-preview.test',
                cucm_username: 'admin',
                cucm_password: 'not-in-grant',
                cucm_version: '14.0',
                operation: 'updatePhone',
                data: { name: 'SEP001122334455', description: 'approved' },
              },
            },
          },
          { signal: controller.signal }
        )
      ).rejects.toMatchObject({ data: { policyCode: 'AXL_REQUEST_CANCELLED' } });
      expect(executeOperation).not.toHaveBeenCalled();
    } finally {
      await server.shutdown();
    }
  });

  it('returns the classified unknown outcome after SDK cancellation of a dispatched mutation', async () => {
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let markDispatched!: () => void;
    const dispatched = new Promise<void>(resolve => {
      markDispatched = resolve;
    });
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: options =>
        new Promise((_resolve, reject) => {
          markDispatched();
          options.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new AxlPolicyError(
                  'AXL_MUTATION_OUTCOME_UNKNOWN',
                  'Mutation outcome is unknown after cancellation post-dispatch'
                )
              ),
            { once: true }
          );
        }),
    };
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

    try {
      const outcome = call(
        {
          method: 'tools/call',
          params: {
            name: 'axl_execute',
            arguments: {
              cucm_host: 'cancelled-mutation.test',
              cucm_username: 'admin',
              cucm_password: 'not-logged',
              cucm_version: '14.0',
              operation: 'updatePhone',
              data: { name: 'SEP001122334455', description: 'approved' },
              mutationGrant: { deliberately: 'stubbed at the runner boundary' },
            },
          },
        },
        { signal: controller.signal }
      );
      await dispatched;
      controller.abort();

      await expect(outcome).rejects.toMatchObject({
        data: { policyCode: 'AXL_MUTATION_OUTCOME_UNKNOWN' },
      });
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });

  it('rejects burst overflow before it creates additional runner work', async () => {
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let started = 0;
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: async () => {
        started++;
        return { ok: true };
      },
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
      inFlight: Map<Promise<unknown>, AbortController>;
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');
    const request = {
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_host: 'burst-capacity.test',
          cucm_username: 'admin',
          cucm_password: 'not-logged',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP111' },
        },
      },
    };

    try {
      for (let index = 0; index < 64; index++) {
        internal.inFlight.set(Promise.resolve(), new AbortController());
      }
      await expect(call(request)).rejects.toMatchObject({
        data: { policyCode: 'AXL_REQUEST_OVERLOADED' },
      });
      expect(started).toBe(0);
      internal.inFlight.clear();
      await expect(server.shutdown()).resolves.toBeUndefined();
    } finally {
      internal.inFlight.clear();
      await server.shutdown().catch(() => undefined);
    }
  });

  it('registers tools/list and tools/call handlers and rejects calls after shutdown', async () => {
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    const internal = server as unknown as {
      server: {
        _requestHandlers: Map<string, (request: unknown) => Promise<unknown>>;
      };
    };
    const list = internal.server._requestHandlers.get('tools/list');
    const call = internal.server._requestHandlers.get('tools/call');
    if (!list || !call) throw new Error('registered MCP handlers missing');

    try {
      await expect(list({ method: 'tools/list', params: {} })).resolves.toMatchObject({
        tools: expect.any(Array),
      });
      await server.shutdown();
      await expect(
        call({ method: 'tools/call', params: { name: 'axl_list_objects', arguments: {} } })
      ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  });

  it('releases real admission slots after a full burst and accepts the next request', async () => {
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let started = 0;
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: async () => {
        started++;
        await gate;
        return { ok: true };
      },
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
      inFlight: Map<Promise<unknown>, AbortController>;
    };
    const call = internal.server._requestHandlers.get('tools/call');
    if (!call) throw new Error('tools/call handler missing');
    const request = {
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_host: 'admission-release.test',
          cucm_username: 'admin',
          cucm_password: 'not-logged',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP111' },
        },
      },
    };

    try {
      const burst = Array.from({ length: 64 }, () => call(request));
      await vi.waitFor(() => {
        expect(internal.inFlight.size).toBe(64);
        expect(started).toBe(64);
      });
      await expect(call(request)).rejects.toMatchObject({
        data: { policyCode: 'AXL_REQUEST_OVERLOADED' },
      });
      release();
      await expect(Promise.all(burst)).resolves.toHaveLength(64);
      expect(internal.inFlight.size).toBe(0);

      await expect(call(request)).resolves.toMatchObject({ content: expect.any(Array) });
      expect(started).toBe(65);
    } finally {
      release();
      await server.shutdown().catch(() => undefined);
    }
  });

  it('all tools should have valid inputSchema structure', () => {
    getTools().forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    });
  });

  it('all tools should have annotations with required hints', () => {
    const validHintKeys = [
      'title',
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ];
    getTools().forEach(tool => {
      expect(tool.annotations, `Tool ${tool.name} is missing annotations`).toBeDefined();
      const annotations = tool.annotations!;
      expect(typeof annotations.title).toBe('string');
      expect(typeof annotations.readOnlyHint).toBe('boolean');
      expect(typeof annotations.destructiveHint).toBe('boolean');
      expect(typeof annotations.idempotentHint).toBe('boolean');
      expect(typeof annotations.openWorldHint).toBe('boolean');
      // No unexpected keys
      for (const key of Object.keys(annotations)) {
        expect(validHintKeys, `Tool ${tool.name} has unexpected annotation key "${key}"`).toContain(
          key
        );
      }
    });
  });

  it('read-only tools should not be marked destructive', () => {
    getTools().forEach(tool => {
      if (tool.annotations?.readOnlyHint) {
        expect(
          tool.annotations.destructiveHint,
          `Tool ${tool.name} is readOnly but also destructive`
        ).toBe(false);
      }
    });
  });

  it('required fields should reference existing properties', () => {
    getTools().forEach(tool => {
      if (tool.inputSchema.required) {
        tool.inputSchema.required.forEach(reqField => {
          expect(
            tool.inputSchema.properties[reqField],
            `Tool ${tool.name} has required field "${reqField}" not in properties`
          ).toBeDefined();
        });
      }
    });
  });

  it('accepts cucm_version for each discovery tool', () => {
    for (const toolName of [
      'axl_list_objects',
      'axl_list_operations',
      'axl_describe_operation',
      'axl_list_action_operations',
    ]) {
      const tool = getTools().find(candidate => candidate.name === toolName);
      expect(tool?.inputSchema.properties).toHaveProperty('cucm_version');
    }
  });

  it('does not advertise SQL tools when SQL is disabled', () => {
    const toolNames = getTools(testConfig()).map(tool => tool.name);

    expect(toolNames).not.toContain('axl_sql_query');
    expect(toolNames).not.toContain('axl_sql_update');
  });

  it('advertises mutation preview only when an effective mutation capability exists', () => {
    expect(getTools(testConfig()).map(tool => tool.name)).not.toContain('axl_preview_mutation');
    expect(
      getTools(testConfig({ enabledObjects: new Set(['Phone']) })).map(tool => tool.name)
    ).toContain('axl_preview_mutation');
    for (const config of [
      testConfig({ sqlEnabled: true }),
      testConfig({ allowGlobalActions: true }),
      testConfig({ enabledObjects: null }),
    ]) {
      expect(getTools(config).map(tool => tool.name)).toContain('axl_preview_mutation');
    }
    const preview = getTools(testConfig({ enabledObjects: new Set(['Phone']) })).find(
      tool => tool.name === 'axl_preview_mutation'
    );
    expect(preview?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('does not advertise mutation preview for an enabled object with only reads in every version', () => {
    expect(
      getTools(testConfig({ enabledObjects: new Set(['AssignedPresenceServers']) })).map(
        tool => tool.name
      )
    ).not.toContain('axl_preview_mutation');
  });

  it('advertises SQL tools only with the explicit SQL capability', () => {
    const toolNames = getTools(testConfig({ sqlEnabled: true })).map(tool => tool.name);

    expect(toolNames).toContain('axl_sql_query');
    expect(toolNames).toContain('axl_sql_update');
  });

  it('advertises SQL queries as grant-bound ambiguous mutations', () => {
    const query = getTools(testConfig({ sqlEnabled: true })).find(
      candidate => candidate.name === 'axl_sql_query'
    );

    expect(query?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(query?.description).toContain('mutation grant');
    const mutationGrantSchema = query?.inputSchema.properties.mutationGrant as
      { description?: unknown } | undefined;
    expect(mutationGrantSchema?.description).toMatch(/required/i);
    expect(query?.inputSchema.required).toContain('mutationGrant');
    expect(query?.inputSchema.properties.mutationGrant).toMatchObject({
      description: expect.stringMatching(/preview/i),
    });
    const update = getTools(testConfig({ sqlEnabled: true })).find(
      candidate => candidate.name === 'axl_sql_update'
    );
    expect(update?.inputSchema.required).toContain('mutationGrant');
  });

  it('does not expose inline credentials in default MCP schemas', () => {
    for (const tool of getTools(testConfig({ sqlEnabled: true }))) {
      expect(tool.inputSchema.properties).not.toHaveProperty('cucm_host');
      expect(tool.inputSchema.properties).not.toHaveProperty('cucm_username');
      expect(tool.inputSchema.properties).not.toHaveProperty('cucm_password');
    }
  });

  it('adds inline credential fields only for explicit compatibility mode', () => {
    const tools = getTools(testConfig({ sqlEnabled: true, allowInlineCredentials: true }));

    for (const name of ['axl_execute', 'axl_preview_mutation', 'axl_sql_query', 'axl_sql_update']) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty('cucm_host');
      expect(tool?.inputSchema.properties).toHaveProperty('cucm_username');
      expect(tool?.inputSchema.properties).toHaveProperty('cucm_password');
    }
    for (const name of [
      'axl_list_objects',
      'axl_list_operations',
      'axl_describe_operation',
      'axl_list_action_operations',
    ]) {
      const tool = tools.find(candidate => candidate.name === name);
      expect(tool?.inputSchema.properties).not.toHaveProperty('cucm_host');
      expect(tool?.inputSchema.properties).not.toHaveProperty('cucm_username');
      expect(tool?.inputSchema.properties).not.toHaveProperty('cucm_password');
    }
  });

  it.each([
    ['cucm_password', 'canonical'],
    ['cucmPassword', 'camel-case canonical alias'],
    ['password', 'common password alias'],
    ['host', 'common host alias'],
    ['username', 'common username alias'],
    ['cucm_pass', 'prefixed password alias'],
    ['cucm_user', 'prefixed username alias'],
    ['cucm_hostname', 'prefixed host alias'],
    ['login', 'login alias'],
    ['secret', 'secret alias'],
    ['userid', 'user id alias'],
    ['cucm_user_id', 'prefixed user id alias'],
    ['passphrase', 'passphrase alias'],
    ['api_token', 'api token alias'],
    ['access_token', 'access token alias'],
    ['auth_token', 'auth token alias'],
    ['client_secret', 'client secret alias'],
  ])(
    'rejects a top-level %s credential attempt before every tool handler (%s)',
    async (field, _label) => {
      const baseArgs: Record<string, Record<string, unknown>> = {
        axl_execute: {
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
        },
        axl_list_objects: { cucm_version: '14.0' },
        axl_list_operations: { cucm_version: '14.0', objectName: 'Phone' },
        axl_describe_operation: { cucm_version: '14.0', operationName: 'getPhone' },
        axl_list_action_operations: { cucm_version: '14.0' },
        axl_sql_query: { cucm_version: '14.0', sql: 'SELECT 1' },
        axl_sql_update: { cucm_version: '14.0', sql: 'UPDATE device SET name = name' },
      };
      let calls = 0;
      const runner: AxlRunner = {
        runAxl: async () => {
          calls++;
          return { ok: true };
        },
      };

      for (const tool of getTools(testConfig({ sqlEnabled: true }))) {
        await expect(
          handleTool(
            tool.name,
            { ...baseArgs[tool.name], [field]: undefined },
            runner,
            testConfig({ sqlEnabled: true, enabledObjects: new Set(['Phone']) })
          )
        ).rejects.toMatchObject({ data: { policyCode: 'AXL_INLINE_CREDENTIALS_DISABLED' } });
      }
      expect(calls).toBe(0);
    }
  );

  it('allows canonical credentials only for compatibility-enabled execution tools', async () => {
    const baseArgs: Record<string, Record<string, unknown>> = {
      axl_execute: {
        cucm_version: '14.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
      },
      axl_sql_query: { cucm_version: '14.0', sql: 'SELECT 1' },
      axl_sql_update: { cucm_version: '14.0', sql: 'UPDATE device SET name = name' },
    };
    let calls = 0;
    const runner: AxlRunner = {
      runAxl: async () => {
        calls++;
        return { ok: true };
      },
    };
    const config = testConfig({
      sqlEnabled: true,
      enabledObjects: new Set(['Phone']),
      allowInlineCredentials: true,
    });

    for (const name of ['axl_execute', 'axl_sql_query', 'axl_sql_update']) {
      await expect(
        handleTool(
          name,
          {
            ...baseArgs[name],
            cucm_host: 'compat-cluster',
            cucm_username: 'compat-user',
            cucm_password: 'compat-password',
          },
          runner,
          config
        )
      ).resolves.toBeTruthy();
    }
    expect(calls).toBe(3);
  });

  it.each([
    ['discovery canonical input', 'axl_list_objects', 'cucm_password'],
    ['discovery alias input', 'axl_list_objects', 'secret'],
    ['execution alias input', 'axl_execute', 'cucm_pass'],
    ['execution api token alias', 'axl_execute', 'api_token'],
    ['execution client secret alias', 'axl_execute', 'client_secret'],
    ['execution bearer key alias', 'axl_execute', 'bearer_key'],
    ['execution session id alias', 'axl_execute', 'session_id'],
    ['execution user id alias', 'axl_execute', 'cucm_user_id'],
  ])('rejects %s even when compatibility mode is enabled', async (_label, name, field) => {
    const baseArgs: Record<string, Record<string, unknown>> = {
      axl_execute: {
        cucm_version: '14.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
      },
      axl_list_objects: { cucm_version: '14.0' },
    };
    let calls = 0;
    const runner: AxlRunner = {
      runAxl: async () => {
        calls++;
        return { ok: true };
      },
    };

    await expect(
      handleTool(
        name,
        { ...baseArgs[name], [field]: undefined },
        runner,
        testConfig({
          sqlEnabled: true,
          enabledObjects: new Set(['Phone']),
          allowInlineCredentials: true,
        })
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_INLINE_CREDENTIALS_DISABLED' } });
    expect(calls).toBe(0);
  });

  it('allows nested AXL payload fields named like credentials', async () => {
    const originalEnv = { ...process.env };
    process.env.CUCM_HOST = 'configured-cluster';
    process.env.CUCM_USERNAME = 'configured-user';
    process.env.CUCM_PASSWORD = 'configured-password';
    try {
      let calls = 0;
      const runner: AxlRunner = {
        runAxl: async () => {
          calls++;
          return { ok: true };
        },
      };
      await expect(
        handleTool(
          'axl_execute',
          {
            cucm_version: '14.0',
            operation: 'getPhone',
            data: { name: 'SEP001122334455', password: 'an-axl-payload-field' },
          },
          runner,
          testConfig({ enabledObjects: new Set(['Phone']) })
        )
      ).resolves.toBeTruthy();
      expect(calls).toBe(1);
    } finally {
      process.env = originalEnv;
    }
  });

  it('writes exactly one value-free warning when inline-credential compatibility starts', () => {
    const secretValues = ['private-cluster.internal', 'compat-user', 'compat-password'];
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      new CiscoAxlMcpServer(
        testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
      );
      expect(warning).toHaveBeenCalledTimes(1);
      const output = warning.mock.calls.flat().join(' ');
      expect(output).toContain('inline CUCM credential');
      for (const secret of secretValues) expect(output).not.toContain(secret);
    } finally {
      warning.mockRestore();
    }
  });

  it('removes both shutdown listeners after idempotent controlled shutdown', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const server = new CiscoAxlMcpServer(testConfig({ enabledObjects: new Set(['Phone']) }));

    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
    await server.shutdown();
    await server.shutdown();

    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('bounds shutdown without replacing a noncooperative route outcome', async () => {
    vi.useFakeTimers();
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let signalSeen: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: async options => {
        signalSeen = options.signal;
        markStarted();
        return new Promise(() => undefined);
      },
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
    };
    const callHandler = internal.server._requestHandlers.get('tools/call');
    if (!callHandler) throw new Error('tools/call handler missing');

    const request = callHandler({
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_host: 'shutdown-test.local',
          cucm_username: 'admin',
          cucm_password: 'not-logged',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP111' },
        },
      },
    });
    let requestSettled = false;
    void request.then(
      () => {
        requestSettled = true;
      },
      () => {
        requestSettled = true;
      }
    );
    await started;
    const shutdown = server.shutdown();
    let shutdownSettled = false;
    void shutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(signalSeen?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(shutdownSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(shutdown).rejects.toThrow('Shutdown incomplete');
    expect(requestSettled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('clears the bounded-drain loser timer when an active production route cancels promptly', async () => {
    vi.useFakeTimers();
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: async options =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), {
            once: true,
          });
          markStarted();
        }),
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
    };
    const callHandler = internal.server._requestHandlers.get('tools/call');
    if (!callHandler) throw new Error('tools/call handler missing');
    const request = callHandler({
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_host: 'prompt-shutdown.local',
          cucm_username: 'admin',
          cucm_password: 'not-logged',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP111' },
        },
      },
    });
    const requestOutcome = request.catch(error => error);
    await started;

    await expect(server.shutdown()).resolves.toBeUndefined();
    await expect(requestOutcome).resolves.toMatchObject({ code: ErrorCode.InternalError });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('drains a production adaptive-delay request promptly on shutdown without dispatch or abandonment', async () => {
    vi.useFakeTimers();
    const originalAuditDir = getAuditDir();
    const auditDir = mkdtempSync(join(tmpdir(), 'axl-shutdown-delay-'));
    setAuditDir(auditDir);
    const host = 'adaptive-delay-shutdown.local';
    for (let index = 0; index < 3; index++) {
      writeAuditEntry(host, {
        ts: new Date().toISOString(),
        operation: 'listPhone',
        durationMs: 1,
        status: 'throttled',
      });
    }
    const server = new CiscoAxlMcpServer(
      testConfig({ allowInlineCredentials: true, enabledObjects: new Set(['Phone']) })
    );
    let markRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>(resolve => {
      markRunnerStarted = resolve;
    });
    const service = new AxlAPIService({
      tlsMode: 'secure',
      requestTimeoutMs: 60_000,
      clientCacheMaxEntries: 2,
    });
    (server as unknown as { runner: AxlRunner }).runner = {
      runAxl: options => {
        markRunnerStarted();
        return service.executeOperation(
          options.request.credentials,
          options.request.operation,
          options.request.data,
          options.request.opts,
          options.request.tlsMode,
          { ...STRICT_AXL_EXECUTION_POLICY, shutdownSignal: options.signal }
        );
      },
    };
    const internal = server as unknown as {
      server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> };
    };
    const callHandler = internal.server._requestHandlers.get('tools/call');
    if (!callHandler) throw new Error('tools/call handler missing');
    const request = callHandler({
      method: 'tools/call',
      params: {
        name: 'axl_execute',
        arguments: {
          cucm_host: host,
          cucm_username: 'admin',
          cucm_password: 'not-logged',
          cucm_version: '14.0',
          operation: 'getPhone',
          data: { name: 'SEP111' },
        },
      },
    });
    const requestOutcome = request.catch(error => error);
    const diagnostics = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await runnerStarted;
      await vi.advanceTimersByTimeAsync(0);
      await expect(server.shutdown()).resolves.toBeUndefined();
      await expect(requestOutcome).resolves.toMatchObject({
        code: ErrorCode.InvalidParams,
        data: { policyCode: 'AXL_REQUEST_CANCELLED' },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(diagnostics.mock.calls.flat().join('')).not.toContain('shutdown_drain_abandoned');
      await flushAuditLog();
      const beforeAdvance = readFileSync(auditLogPathForHost(host), 'utf-8');
      await vi.advanceTimersByTimeAsync(10_000);
      await flushAuditLog();
      expect(readFileSync(auditLogPathForHost(host), 'utf-8')).toBe(beforeAdvance);
    } finally {
      diagnostics.mockRestore();
      setAuditDir(originalAuditDir);
      rmSync(auditDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('reports a transport-server close failure while still cleaning shutdown state', async () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const server = new CiscoAxlMcpServer(testConfig());
    const internal = server as unknown as {
      server: { close: () => Promise<void> };
    };
    const close = vi
      .spyOn(internal.server, 'close')
      .mockRejectedValue(new Error('transport close failed'));

    await expect(server.shutdown()).rejects.toMatchObject({ message: 'Shutdown incomplete' });
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('reports an audit flush failure while still completing shutdown cleanup', async () => {
    const originalAuditDir = getAuditDir();
    const auditRoot = mkdtempSync(join(tmpdir(), 'axl-shutdown-audit-failure-'));
    const blockedPath = join(auditRoot, 'blocked-destination');
    writeFileSync(blockedPath, 'not a directory');
    setAuditDir(blockedPath);
    const diagnostics = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const server = new CiscoAxlMcpServer(testConfig());
    recordOperation('audit-flush-failure.local', 'getPhone', Date.now(), { ok: true });

    try {
      await expect(server.shutdown()).rejects.toThrow('Shutdown incomplete');
      expect(diagnostics.mock.calls.flat().join('')).toContain('audit_write_failed');
    } finally {
      diagnostics.mockRestore();
      setAuditDir(originalAuditDir);
      rmSync(auditRoot, { recursive: true, force: true });
    }
  });

  it('routes signal shutdown success and failure to the corresponding process exit code', async () => {
    const server = new CiscoAxlMcpServer(testConfig());
    const handler = (server as unknown as { signalHandler: () => void }).signalHandler;
    const shutdown = vi.spyOn(server, 'shutdown');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const originalExitCode = process.exitCode;

    try {
      shutdown.mockResolvedValueOnce(undefined);
      handler();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

      exit.mockClear();
      shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
      handler();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      exit.mockRestore();
      shutdown.mockRestore();
      await server.shutdown().catch(() => undefined);
    }
  });

  it('runs the stdio bootstrap and reports the configured TLS mode', async () => {
    const server = new CiscoAxlMcpServer(testConfig({ tlsMode: 'insecure' }));
    const internal = server as unknown as {
      server: { connect: (transport: unknown) => Promise<void> };
    };
    const connect = vi.spyOn(internal.server, 'connect').mockResolvedValue(undefined);
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await server.run();
      expect(connect).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledWith(expect.stringContaining('TLS verification: disabled'));
    } finally {
      output.mockRestore();
      await server.shutdown();
    }
  });

  it('constructs the MCP server through startMcp without publishing runtime exports', async () => {
    const beforeInt = new Set(process.listeners('SIGINT'));
    const beforeTerm = new Set(process.listeners('SIGTERM'));
    const run = vi.spyOn(CiscoAxlMcpServer.prototype, 'run').mockResolvedValue(undefined);

    try {
      await startMcp(testConfig());
      expect(run).toHaveBeenCalledOnce();
    } finally {
      run.mockRestore();
      for (const listener of process.listeners('SIGINT')) {
        if (!beforeInt.has(listener)) process.off('SIGINT', listener);
      }
      for (const listener of process.listeners('SIGTERM')) {
        if (!beforeTerm.has(listener)) process.off('SIGTERM', listener);
      }
    }
  });

  it('rejects supplied inline credentials by default without echoing their values', async () => {
    const secret = 'inline-password-that-must-not-leak';
    await expect(
      handleTool(
        'axl_execute',
        {
          cucm_password: secret,
          operation: 'getPhone',
          data: { name: 'SEP001122334455' },
        },
        createMockAxlAPI(),
        testConfig({ enabledObjects: new Set(['Phone']) })
      )
    ).rejects.toMatchObject({ data: { policyCode: 'AXL_INLINE_CREDENTIALS_DISABLED' } });
    try {
      await handleTool(
        'axl_execute',
        { cucm_password: secret, operation: 'getPhone', data: { name: 'SEP001122334455' } },
        createMockAxlAPI(),
        testConfig({ enabledObjects: new Set(['Phone']) })
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('should return null for unknown tools', async () => {
    const result = await handleTool('nonexistent_tool', {}, createMockAxlAPI());
    expect(result).toBeNull();
  });

  it('should return valid MCP tool response format', async () => {
    const originalEnabledObjects = process.env.AXL_MCP_ENABLED_OBJECTS;
    process.env.AXL_MCP_ENABLED_OBJECTS = 'Phone';
    try {
      const result = await handleTool(
        'axl_execute',
        {
          cucm_host: 'example.local',
          cucm_username: 'user',
          cucm_password: 'pass',
          cucm_version: '14.0',
          operation: 'addPhone',
          data: {
            phone: {
              name: 'SEP001122334455',
              product: 'Cisco 8845',
              class: 'Phone',
              protocol: 'SIP',
              devicePoolName: 'Default',
            },
          },
        },
        createMockAxlAPI(),
        testConfig({ enabledObjects: new Set(['Phone']), allowInlineCredentials: true })
      );

      expect(result).not.toBeNull();
      expect(Array.isArray(result?.content)).toBe(true);
      expect(result?.content[0]).toHaveProperty('type', 'text');
      expect(result?.content[0]).toHaveProperty('text');
      expect(() => JSON.parse(result!.content[0]!.text)).not.toThrow();
    } finally {
      if (originalEnabledObjects === undefined) delete process.env.AXL_MCP_ENABLED_OBJECTS;
      else process.env.AXL_MCP_ENABLED_OBJECTS = originalEnabledObjects;
    }
  });
});
