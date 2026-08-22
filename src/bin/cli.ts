#!/usr/bin/env node
import { isDirectExecution } from '../lib/entrypoint';
import { writeMetadata } from './metadata';

const CLI_HELP = `Cisco AXL command-line client

Usage:
  cisco-axl-mcp-cli versions
  cisco-axl-mcp-cli objects --version <CUCM_VERSION>
  cisco-axl-mcp-cli operations --version <CUCM_VERSION> [--object <OBJECT>]
  cisco-axl-mcp-cli describe <OPERATION> --version <CUCM_VERSION>
  cisco-axl-mcp-cli execute <OPERATION> --data <JSON|@FILE> [--write --confirm <OPERATION>]
  cisco-axl-mcp-cli sql query [--file <FILE>] [--write --confirm sql-query]
  cisco-axl-mcp-cli sql update [--file <FILE>] [--write --confirm sql-update]
`;

async function startAfterMetadata(): Promise<void> {
  // Metadata must remain import-free, while normal direct CLI execution keeps
  // the package's established .env configuration behavior.
  await import('dotenv/config');
  const { runCli } = await import('../cli');
  process.exitCode = await runCli();
}

if (isDirectExecution(import.meta.url) && !writeMetadata(process.argv.slice(2), CLI_HELP)) {
  void startAfterMetadata().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
