import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getOptionalString, isRecord } from '../credentials';
import type { ToolCredentialOverrides } from '../credentials';
import { AxlPolicyError } from './errors';

const CANONICAL_INLINE_CREDENTIAL_FIELDS = new Set(['cucm_host', 'cucm_username', 'cucm_password']);

const CREDENTIAL_COMPOUND_PREFIXES = new Set([
  'api',
  'access',
  'auth',
  'client',
  'bearer',
  'session',
]);

const CREDENTIAL_COMPOUND_SUFFIXES = new Set(['token', 'key', 'secret', 'id']);

function normalizedTopLevelKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A deliberately bounded matcher for model-visible credential attempts. It
 * recognizes common host/user/password/login/secret spellings and bounded
 * credential compounds, optionally prefixed with CUCM, without treating
 * ordinary tool fields as credentials.
 */
function isCredentialAttemptName(key: string): boolean {
  const normalized = normalizedTopLevelKey(key);
  const base = normalized.startsWith('cucm') ? normalized.slice('cucm'.length) : normalized;
  if (
    /^(?:host(?:name)?|user(?:name|id)?|login|pass(?:word|wd|phrase)?|pwd|secret(?:key)?|credential(?:s)?|token|auth(?:entication)?|authorization|apikey|accesskey)$/.test(
      base
    )
  ) {
    return true;
  }

  for (const prefix of CREDENTIAL_COMPOUND_PREFIXES) {
    for (const suffix of CREDENTIAL_COMPOUND_SUFFIXES) {
      if (base === `${prefix}${suffix}`) return true;
    }
  }
  return false;
}

/**
 * Reject model-visible credential attempts before any tool-specific parsing.
 * The check intentionally examines only top-level MCP arguments so legitimate
 * AXL request payload fields such as `data.password` remain valid.
 */
export function assertInlineCredentialPolicy(
  obj: Record<string, unknown>,
  allowCanonicalInlineCredentials = false
): void {
  for (const key of Object.keys(obj)) {
    if (!isCredentialAttemptName(key)) continue;
    if (allowCanonicalInlineCredentials && CANONICAL_INLINE_CREDENTIAL_FIELDS.has(key)) continue;
    throw new AxlPolicyError(
      'AXL_INLINE_CREDENTIALS_DISABLED',
      'Inline CUCM credentials are disabled; configure CUCM_HOST, CUCM_USERNAME, and CUCM_PASSWORD in the MCP host environment'
    );
  }
}

export function assertRecord(
  value: unknown,
  message = 'Invalid arguments'
): Record<string, unknown> {
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

export function optionalObject(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new McpError(ErrorCode.InvalidParams, `Invalid "${key}"`);
  return value;
}

export function extractCredentialOverrides(
  obj: Record<string, unknown>,
  allowCanonicalInlineCredentials = false
): ToolCredentialOverrides {
  assertInlineCredentialPolicy(obj, allowCanonicalInlineCredentials);
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
