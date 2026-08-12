import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { redactCredentials } from '../../lib/audit-log';

export class AxlPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AxlPolicyError';
  }
}

export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const redacted = redactCredentials(error);
  const message =
    redacted &&
    typeof redacted === 'object' &&
    typeof (redacted as Record<string, unknown>).message === 'string'
      ? ((redacted as Record<string, unknown>).message as string)
      : String(redacted);

  const lower = message.toLowerCase();
  if (
    lower.includes('authentication failed') ||
    lower.includes('401 unauthorized') ||
    lower.includes('403 forbidden')
  ) {
    return new McpError(ErrorCode.InvalidRequest, message);
  }

  if (lower.includes('not found') && lower.includes('operation')) {
    return new McpError(ErrorCode.InvalidParams, message);
  }

  return new McpError(ErrorCode.InternalError, message);
}
