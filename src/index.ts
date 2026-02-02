#!/usr/bin/env node
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AxlAPIService } from './services/axl/index';
import { getTools, handleTool } from './tools/index';
import { toMcpError } from './types/axl/errors';

class CiscoAxlMcpServer {
  private server: Server;
  private axl: AxlAPIService;

  constructor() {
    this.server = new Server(
      {
        name: 'cisco-axl-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axl = new AxlAPIService();
    this.setupToolHandlers();

    this.server.onerror = error => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getTools() }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      try {
        const { name, arguments: rawArgs } = request.params;
        const args = rawArgs ?? {};

        const result = await handleTool(name, args, this.axl);
        if (result === null) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        return result as CallToolResult;
      } catch (error) {
        throw toMcpError(error);
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Cisco AXL MCP server running on stdio');
  }
}

const server = new CiscoAxlMcpServer();
server.run().catch(console.error);
