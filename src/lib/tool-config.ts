import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AXL_TOP_LEVEL_OBJECTS, type AxlTopLevelObject } from '../types/generated/axl-objects';

export interface AxlMcpConfig {
  enabled_objects?: string[];
  enabledObjects?: string[];
}

function parseCommaList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseEnabledObjectsFromArgv(argv: string[]): string[] | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--enabled-objects=')) return parseCommaList(arg.split('=', 2)[1] ?? '');
    if (arg === '--enabled-objects') return parseCommaList(argv[i + 1] ?? '');
  }
  return undefined;
}

function normalizeObjectKey(value: string): string {
  return value.trim();
}

export function getEnabledTopLevelObjects(): Set<AxlTopLevelObject> | null {
  const configJson = process.env.AXL_MCP_CONFIG;
  let config: AxlMcpConfig | undefined;
  if (configJson) {
    try {
      config = JSON.parse(configJson) as AxlMcpConfig;
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid AXL_MCP_CONFIG JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const fromJson = config?.enabled_objects ?? config?.enabledObjects;
  const fromEnv = process.env.AXL_MCP_ENABLED_OBJECTS
    ? parseCommaList(process.env.AXL_MCP_ENABLED_OBJECTS)
    : undefined;
  const fromArgv = parseEnabledObjectsFromArgv(process.argv.slice(2));

  const enabled = fromArgv ?? fromEnv ?? fromJson;
  if (!enabled || enabled.length === 0) return null;
  const first = enabled[0];
  if (enabled.length === 1 && first && ['*', 'all'].includes(first.toLowerCase())) return null;

  const valid = new Set<string>(AXL_TOP_LEVEL_OBJECTS as unknown as string[]);
  const selected = new Set<AxlTopLevelObject>();
  const invalid: string[] = [];

  for (const raw of enabled) {
    const key = normalizeObjectKey(raw);
    if (!valid.has(key)) invalid.push(key);
    else selected.add(key as AxlTopLevelObject);
  }

  if (invalid.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown enabled_objects: ${invalid.join(', ')} (see generated/axl-top-level-objects.json)`
    );
  }

  return selected;
}
