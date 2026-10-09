/**
 * Universal Streamable HTTP / Web Standards Fetch Handler for Cisco AXL MCP.
 *
 * Implements the MCP 2026-07-28 Streamable HTTP specification over standard
 * Web Fetch API (Request -> Response). Compatible with Cloudflare Workers,
 * Bun, Deno, Fastify, and Node.js fetch runtimes.
 */

import { getTools, handleTool } from './tools/index';
import { createStartupRuntime, SERVER_NAME, SERVER_VERSION } from './server';
import { loadMcpConfig, type ResolvedMcpConfig } from './lib/tool-config';
import { AxlAPIService, resolveAxlServiceOptions } from './services/axl/index';
import { createAxlRunner, type AxlRunner } from './lib/axl-runner';
import { MutationGrantAuthority, MutationGrantReplayStore } from './lib/mutation-grants';
import type { AxlToolRuntime } from './lib/credential-resolver';

export interface FetchHandlerOptions {
  /** Optional base path filter (e.g. "/cisco_axl" or "/mcp") */
  basePath?: string;
  /** Optional custom environment variables */
  env?: Record<string, string | undefined>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Mcp-Method, Mcp-Name, MCP-Protocol-Version, x-ct-agent',
};

function jsonResponse(
  status: number,
  data: unknown,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function createFetchRunner(
  config: ResolvedMcpConfig,
  env: NodeJS.ProcessEnv
): { runner: AxlRunner; runtime: AxlToolRuntime } {
  const grantAuthority = new MutationGrantAuthority();
  const replayStore = new MutationGrantReplayStore();
  const service = new AxlAPIService(
    resolveAxlServiceOptions(config, env)
  );
  const runner = createAxlRunner({
    service,
    grantAuthority,
    replayStore,
  });
  const runtime = createStartupRuntime(config, env);
  return { runner, runtime };
}

export async function handleMcpFetchRequest(
  request: Request,
  env?: Record<string, string | undefined>,
  options: FetchHandlerOptions = {}
): Promise<Response> {
  const mergedEnv: NodeJS.ProcessEnv = {
    ...(typeof process !== 'undefined' ? process.env : {}),
    ...options.env,
    ...env,
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  const config = loadMcpConfig(mergedEnv);

  // Health check routes
  if (
    request.method === 'GET' &&
    (pathname === '/healthz' ||
      pathname === '/health' ||
      pathname.endsWith('/healthz') ||
      pathname.endsWith('/health'))
  ) {
    return jsonResponse(200, {
      status: 'ok',
      service: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      tools_count: getTools(config).length,
    });
  }

  // MCP JSON-RPC routes: POST to /mcp, /cisco_axl/mcp, or root /
  if (request.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: Invalid JSON' },
      });
    }

    const { id, method, params } = body;
    const typedParams = (params as Record<string, unknown>) || {};

    if (method === 'initialize') {
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    }

    if (method === 'notifications/initialized') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (method === 'ping') {
      return jsonResponse(200, { jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id,
        result: { tools: getTools(config) },
      });
    }

    if (method === 'tools/call') {
      const toolName = String(typedParams.name || '');
      const toolArgs = (typedParams.arguments as Record<string, unknown>) || {};

      if (!toolName) {
        return jsonResponse(400, {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params: tool name required' },
        });
      }

      try {
        const { runner, runtime } = createFetchRunner(config, mergedEnv);
        const result = await handleTool(
          toolName,
          toolArgs,
          runner,
          config,
          undefined,
          runtime
        );
        if (result === null) {
          return jsonResponse(400, {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          });
        }
        return jsonResponse(200, {
          jsonrpc: '2.0',
          id,
          result,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse(200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          },
        });
      }
    }

    return jsonResponse(400, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }

  return jsonResponse(404, { error: 'Not Found' });
}

export default {
  fetch: handleMcpFetchRequest,
};
