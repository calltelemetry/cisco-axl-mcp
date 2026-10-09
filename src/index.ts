#!/usr/bin/env node
import { isDirectExecution } from './lib/entrypoint';
import { writeMetadata } from './bin/metadata';
import { loadMcpConfig, type ResolvedMcpConfig } from './lib/tool-config';
import type { AxlToolRuntime } from './lib/credential-resolver';

export * from './server';
export { getTools, handleTool } from './tools/index';
export { handleMcpFetchRequest, createFetchRunner } from './fetch';
export { startSseServer } from './sse';

const MCP_HELP = `Cisco AXL MCP server

Usage:
  cisco-axl-mcp

Starts the CUCM AXL Model Context Protocol server over stdio. Configure CUCM_* process
environment variables before starting the server. Use cisco-axl-mcp-cli for direct commands.
`;

async function startValidatedMcp(
  config: ResolvedMcpConfig,
  runtime?: AxlToolRuntime
): Promise<void> {
  const { startMcp } = await import('./server');
  await startMcp(config, runtime);
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
  await import('dotenv/config');
  const config = loadStartupConfig();
  if (config !== undefined) {
    const startupEnvironment = Object.freeze({ ...process.env });
    const runtime = config.credentialProvider
      ? Object.freeze({
          credentialSource: (await import('./lib/credential-source')).createCredentialSource(
            config,
            startupEnvironment
          ),
          startupEnvironment,
          now: () => Date.now(),
        })
      : undefined;
    await startValidatedMcp(config, runtime);
  }
}

if (isDirectExecution(import.meta.url) && !writeMetadata(process.argv.slice(2), MCP_HELP)) {
  void startAfterMetadata().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
