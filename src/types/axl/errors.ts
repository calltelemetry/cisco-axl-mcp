import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : String(error);

  const lower = message.toLowerCase();
  if (lower.includes('authentication failed') || lower.includes('401 unauthorized') || lower.includes('403 forbidden')) {
    return new McpError(ErrorCode.InvalidRequest, message);
  }

  if (lower.includes('not found') && lower.includes('operation')) {
    return new McpError(ErrorCode.InvalidParams, message);
  }

  return new McpError(ErrorCode.InternalError, message);
}
