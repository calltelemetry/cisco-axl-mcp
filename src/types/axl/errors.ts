import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { redactCredentials } from '../../lib/audit-log';
import { AxlPolicyError } from '../../lib/policy-error';

export { AxlPolicyError } from '../../lib/policy-error';

export function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof AxlPolicyError) {
    return new McpError(ErrorCode.InvalidParams, error.message, { policyCode: error.code });
  }
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
