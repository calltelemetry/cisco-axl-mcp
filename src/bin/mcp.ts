#!/usr/bin/env node
import { isDirectExecution } from '../lib/entrypoint';
import { loadMcpConfig, type ResolvedMcpConfig } from '../lib/tool-config';
import { writeMetadata } from './metadata';

const MCP_HELP = `Cisco AXL MCP server

Usage:
  cisco-axl-mcp

Starts the CUCM AXL Model Context Protocol server over stdio. Configure CUCM_* process
environment variables before starting the server. Use cisco-axl-mcp-cli for direct commands.
`;

async function startValidatedMcp(config: ResolvedMcpConfig): Promise<void> {
  const { startMcp } = await import('../index');
  await startMcp(config);
}

function loadStartupConfig(): ResolvedMcpConfig | undefined {
  try {
    return loadMcpConfig(process.env, process.argv);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    return undefined;
  }
}

async function startAfterMetadata(): Promise<void> {
  // Keep direct metadata paths dependency-free, but preserve the package's
  // normal startup contract: dotenv populates process.env before the one
  // immutable policy snapshot is resolved and before MCP/AXL runtime loading.
  await import('dotenv/config');
  const config = loadStartupConfig();
  if (config !== undefined) await startValidatedMcp(config);
}

if (isDirectExecution(import.meta.url) && !writeMetadata(process.argv.slice(2), MCP_HELP)) {
  void startAfterMetadata().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
