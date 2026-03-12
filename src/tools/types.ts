import type { AxlAPIService } from '../services/axl/index';

export interface ToolAnnotations {
  /** Human-readable title for display purposes. */
  title?: string;
  /** If true, the tool does not modify any external state. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform destructive updates (delete, overwrite). */
  destructiveHint?: boolean;
  /** If true, calling the tool repeatedly with the same args has no additional effect. */
  idempotentHint?: boolean;
  /** If true, the tool may interact with the "open world" (network, external APIs). */
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

export type ToolHandler = (name: string, args: unknown, axlAPI: AxlAPIService) => Promise<ToolResult | null>;

export function jsonResponse(data: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export interface ToolModule {
  tools: ToolDefinition[];
  handleTool: ToolHandler;
}

