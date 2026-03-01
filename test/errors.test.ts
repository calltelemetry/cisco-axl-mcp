import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from '../src/types/axl/errors';

describe('toMcpError', () => {
  it('returns McpError unchanged', () => {
    const original = new McpError(ErrorCode.InvalidParams, 'test error');
    const result = toMcpError(original);
    expect(result).toBe(original);
  });

  it('converts "authentication failed" to InvalidRequest', () => {
    const result = toMcpError(new Error('Authentication failed for user admin'));
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidRequest);
    expect(result.message).toContain('Authentication failed');
  });

  it('converts "401 unauthorized" to InvalidRequest', () => {
    const result = toMcpError(new Error('HTTP 401 Unauthorized'));
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidRequest);
  });

  it('converts "403 forbidden" to InvalidRequest', () => {
    const result = toMcpError(new Error('HTTP 403 Forbidden'));
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidRequest);
  });

  it('converts "operation not found" to InvalidParams', () => {
    const result = toMcpError(new Error('Operation not found: fakeOp'));
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InvalidParams);
  });

  it('converts generic error to InternalError', () => {
    const result = toMcpError(new Error('Something broke'));
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('Something broke');
  });

  it('converts non-Error (string) to InternalError', () => {
    const result = toMcpError('raw string error');
    expect(result).toBeInstanceOf(McpError);
    expect(result.code).toBe(ErrorCode.InternalError);
    expect(result.message).toContain('raw string error');
  });
});
