#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { AxlAPIService, resolveAxlServiceOptions } from './services/axl/index';
import { getTools, handleTool } from './tools/index';
import { AxlPolicyError, toMcpError } from './types/axl/errors';
import { PACKAGE_VERSION } from './lib/package-version';
import { createAxlRunner, type AxlRunner } from './lib/axl-runner';
import { MutationGrantAuthority, MutationGrantReplayStore } from './lib/mutation-grants';
import type { ResolvedMcpConfig } from './lib/tool-config';
import { flushAuditLog } from './lib/audit-log';
import { clearAxlClientCache } from './lib/axl-client';
import { emitAxlDiagnostic } from './lib/runtime-diagnostics';
import { createCredentialSource, type CredentialSource } from './lib/credential-source';
import type { AxlToolRuntime } from './lib/credential-resolver';

/**
 * One MCP process is intentionally a bounded admission point. The cap covers
 * active service calls and same-client queue waiters before credentials can
 * allocate another service/client lifecycle.
 */
export const MAX_AXL_MCP_IN_FLIGHT_REQUESTS = 64;

function startupEnvironmentSnapshot(environment: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({ ...environment });
}

/** Static mode keeps legacy lazy credential checks while sharing the startup env boundary. */
function staticRuntimeSource(): CredentialSource {
  return {
    initialize: async () => {
      throw new AxlPolicyError(
        'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
        'Static credentials are resolved at request admission'
      );
    },
    current: () => {
      throw new AxlPolicyError(
        'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
        'Static credentials are resolved at request admission'
      );
    },
    refresh: async () => {
      throw new AxlPolicyError(
        'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
        'Static credentials are resolved at request admission'
      );
    },
    shutdown: async () => undefined,
  };
}

function createStartupRuntime(config: ResolvedMcpConfig): AxlToolRuntime {
  const startupEnvironment = startupEnvironmentSnapshot(process.env);
  const credentialSource = config.credentialProvider
    ? createCredentialSource(config, startupEnvironment)
    : staticRuntimeSource();
  return Object.freeze({
    credentialSource,
    startupEnvironment,
    now: () => Date.now(),
  });
}

/** Combine request and shutdown cancellation without retaining listener references. */
function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listeners.push([signal, abort]);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

export class CiscoAxlMcpServer {
  private server: Server;
  private readonly runner: AxlRunner;
  private readonly runtime: AxlToolRuntime;
  private readonly mutationGrantAuthority = new MutationGrantAuthority();
  private readonly mutationGrantReplayStore = new MutationGrantReplayStore();
  private shutdownPromise: Promise<void> | undefined;
  private acceptingRequests = true;
  private sighupRefreshPromise: Promise<void> | undefined;
  private readonly credentialSighupHandler: (() => void) | undefined;
  /** Tracks the underlying operation, not just the MCP response wrapper. */
  private readonly inFlight = new Map<Promise<unknown>, AbortController>();
  private readonly signalHandler = () => {
    void this.shutdown().then(
      () => process.exit(0),
      () => {
        emitAxlDiagnostic('shutdown_failed');
        process.exitCode = 1;
        process.exit(1);
      }
    );
  };

  constructor(
    private readonly config: ResolvedMcpConfig,
    runtime: AxlToolRuntime = createStartupRuntime(config)
  ) {
    this.runtime = runtime;
    this.server = new Server(
      {
        name: 'cisco-axl-mcp',
        version: PACKAGE_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    if (this.config.allowInlineCredentials) {
      console.error(
        'WARNING: inline CUCM credential fields are enabled for MCP compatibility; they can expose secrets to model transcripts. Prefer CUCM_* environment variables.'
      );
    }
    this.runner = createAxlRunner({
      service: new AxlAPIService(
        resolveAxlServiceOptions(this.config, this.runtime.startupEnvironment)
      ),
      grantAuthority: this.mutationGrantAuthority,
      replayStore: this.mutationGrantReplayStore,
    });
    this.setupToolHandlers();

    this.server.onerror = error => console.error('[MCP Error]', error);
    try {
      process.on('SIGINT', this.signalHandler);
      process.on('SIGTERM', this.signalHandler);
      if (
        this.config.credentialProvider?.refreshOnSighup === true &&
        process.platform !== 'win32'
      ) {
        this.credentialSighupHandler = () => {
          if (this.sighupRefreshPromise || !this.acceptingRequests) return;
          this.sighupRefreshPromise = Promise.resolve()
            .then(() => this.runtime.credentialSource.refresh('sighup'))
            .then(() => undefined)
            .catch(() => {
              emitAxlDiagnostic('credential_refresh_failed');
            })
            .finally(() => {
              this.sighupRefreshPromise = undefined;
            });
        };
        process.on('SIGHUP', this.credentialSighupHandler);
      }
    } catch (error) {
      process.off('SIGINT', this.signalHandler);
      process.off('SIGTERM', this.signalHandler);
      if (this.credentialSighupHandler) process.off('SIGHUP', this.credentialSighupHandler);
      throw error;
    }
  }

  /** Idempotent, value-free controlled shutdown used by signals and embedding callers. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.acceptingRequests = false;
      process.off('SIGINT', this.signalHandler);
      process.off('SIGTERM', this.signalHandler);
      if (this.credentialSighupHandler) process.off('SIGHUP', this.credentialSighupHandler);
      const failures: unknown[] = [];
      try {
        await this.server.close();
      } catch (error) {
        failures.push(error);
      }
      const activeOperations = [...this.inFlight.keys()];
      for (const controller of this.inFlight.values()) controller.abort();
      try {
        await this.runtime.credentialSource.shutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        const drained = await this.awaitDrain(activeOperations, 5_000);
        if (!drained) {
          emitAxlDiagnostic('shutdown_drain_abandoned');
          failures.push(
            new Error('Active AXL operations did not settle before shutdown drain deadline')
          );
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        this.mutationGrantReplayStore.clear();
      } catch (error) {
        failures.push(error);
      }
      try {
        clearAxlClientCache();
      } catch (error) {
        failures.push(error);
      }
      try {
        await flushAuditLog();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Shutdown incomplete');
    })();
    return this.shutdownPromise;
  }

  /** Waits a bounded interval for real operations and always clears the loser timer. */
  private async awaitDrain(
    operations: readonly Promise<unknown>[],
    timeoutMs: number
  ): Promise<boolean> {
    if (operations.length === 0) return true;
    return new Promise(resolve => {
      let finished = false;
      const finish = (drained: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(drained);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      Promise.allSettled(operations).then(() => finish(true));
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getTools(this.config),
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        if (!this.acceptingRequests) {
          throw new McpError(ErrorCode.InternalError, 'Server is shutting down');
        }
        if (this.inFlight.size >= MAX_AXL_MCP_IN_FLIGHT_REQUESTS) {
          emitAxlDiagnostic('axl_request_overloaded');
          throw toMcpError(
            new AxlPolicyError(
              'AXL_REQUEST_OVERLOADED',
              'AXL MCP request capacity is exhausted before dispatch'
            )
          );
        }
        const controller = new AbortController();
        const externalSignal = extra?.signal;
        const combined = composeAbortSignals([externalSignal, controller.signal]);
        const requestPromise = (async () => {
          try {
            const { name, arguments: rawArgs } = request.params;
            const args = rawArgs ?? {};

            const result = await handleTool(
              name,
              args,
              this.runner,
              this.config,
              combined.signal,
              this.runtime
            );
            if (result === null)
              throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            return result as CallToolResult;
          } catch (error) {
            throw toMcpError(error);
          }
        })();
        this.inFlight.set(requestPromise, controller);
        void requestPromise.then(
          () => this.inFlight.delete(requestPromise),
          () => this.inFlight.delete(requestPromise)
        );
        try {
          // The combined SDK/shutdown signal reaches the runner/service/transport.
          // Do not race it with a generic MCP error: a dispatched mutation must
          // return its classified outcome (normally outcome-unknown), even when
          // the client elects to suppress that response after cancellation.
          return await requestPromise;
        } finally {
          combined.dispose();
        }
      }
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `Cisco AXL MCP server running on stdio (TLS verification: ${this.config.tlsMode === 'secure' ? 'enabled' : 'disabled'})`
    );
  }
}

export async function startMcp(
  config: ResolvedMcpConfig,
  runtime: AxlToolRuntime = createStartupRuntime(config)
): Promise<void> {
  let initialized = false;
  let server: CiscoAxlMcpServer | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          if (server) await server.shutdown();
          else if (config.credentialProvider || initialized) {
            await runtime.credentialSource.shutdown();
          }
        } catch {
          emitAxlDiagnostic('shutdown_failed');
        }
      })();
    }
    return cleanupPromise;
  };

  try {
    if (config.credentialProvider) {
      await runtime.credentialSource.initialize();
      initialized = true;
    }
    server = new CiscoAxlMcpServer(config, runtime);
    await server.run();
  } catch (error) {
    await cleanup();
    throw error;
  }
}
