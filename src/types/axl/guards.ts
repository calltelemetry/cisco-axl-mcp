import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOptionalString, isRecord } from '../credentials';
import type { ToolCredentialOverrides } from '../credentials';

export function assertRecord(value: unknown, message = 'Invalid arguments'): Record<string, unknown> {
  if (!isRecord(value)) throw new McpError(ErrorCode.InvalidParams, message);
  return value;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpError(ErrorCode.InvalidParams, `Missing or invalid "${key}"`);
  }
  return value;
}

export function optionalObject(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new McpError(ErrorCode.InvalidParams, `Invalid "${key}"`);
  return value;
}

export function extractCredentialOverrides(obj: Record<string, unknown>): ToolCredentialOverrides {
  return {
    cucm_host: getOptionalString(obj, 'cucm_host'),
    cucm_username: getOptionalString(obj, 'cucm_username'),
    cucm_password: getOptionalString(obj, 'cucm_password'),
    cucm_version: getOptionalString(obj, 'cucm_version'),
  };
}

export function requireNameOrUuid(obj: Record<string, unknown>): { name?: string; uuid?: string } {
  const name = getOptionalString(obj, 'name');
  const uuid = getOptionalString(obj, 'uuid');
  if (!name && !uuid) {
    throw new McpError(ErrorCode.InvalidParams, 'Must provide "name" or "uuid"');
  }
  return { name, uuid };
}

