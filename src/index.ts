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
import { AxlAPIService } from './services/axl/index';
import { getTools, handleTool } from './tools/index';
import { toMcpError } from './types/axl/errors';
import { resolveMcpTlsMode } from './lib/axl-client';
import { isDirectExecution } from './lib/entrypoint';
import { PACKAGE_VERSION } from './lib/package-version';
import type { TlsMode } from './lib/axl-client';

class CiscoAxlMcpServer {
  private server: Server;
  private axl: AxlAPIService;

  constructor(private readonly mcpTlsMode: TlsMode) {
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

    this.axl = new AxlAPIService(this.mcpTlsMode);
    this.setupToolHandlers();

    this.server.onerror = error => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        try {
          const { name, arguments: rawArgs } = request.params;
          const args = rawArgs ?? {};

          const result = await handleTool(name, args, this.axl);
          if (result === null)
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          return result as CallToolResult;
        } catch (error) {
          throw toMcpError(error);
        }
      }
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      `Cisco AXL MCP server running on stdio (TLS verification: ${this.mcpTlsMode === 'secure' ? 'enabled' : 'disabled'})`
    );
  }
}

export async function startMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env === process.env) await import('dotenv/config');
  // Preserve the MCP's legacy self-signed-certificate default only when mode is
  // unset or explicitly configured as default/insecure. Invalid values fail startup.
  const mcpTlsMode = resolveMcpTlsMode(env);
  const server = new CiscoAxlMcpServer(mcpTlsMode);
  await server.run();
}

if (isDirectExecution(import.meta.url)) {
  startMcp().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
