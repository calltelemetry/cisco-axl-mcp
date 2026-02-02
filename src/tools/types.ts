import type { AxlAPIService } from '../services/axl/index';

export interface ToolDefinition {
  name: string;
  description: string;
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

