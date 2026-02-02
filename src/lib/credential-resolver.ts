import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isSupportedCucmVersion, SUPPORTED_CUCM_VERSIONS } from './version-manager';
import type { CucmCredentials, ToolCredentialOverrides } from '../types/credentials';

export function resolveCredentials(overrides: ToolCredentialOverrides): CucmCredentials {
  const host = overrides.cucm_host ?? process.env.CUCM_HOST;
  const username = overrides.cucm_username ?? process.env.CUCM_USERNAME;
  const password = overrides.cucm_password ?? process.env.CUCM_PASSWORD;
  const version = overrides.cucm_version ?? process.env.CUCM_VERSION;

  if (!host) throw new McpError(ErrorCode.InvalidParams, 'Missing CUCM_HOST or cucm_host');
  if (!username) throw new McpError(ErrorCode.InvalidParams, 'Missing CUCM_USERNAME or cucm_username');
  if (!password) throw new McpError(ErrorCode.InvalidParams, 'Missing CUCM_PASSWORD or cucm_password');
  if (!version) throw new McpError(ErrorCode.InvalidParams, 'Missing CUCM_VERSION or cucm_version');

  if (!isSupportedCucmVersion(version)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unsupported cucm_version "${version}" (supported: ${SUPPORTED_CUCM_VERSIONS.join(', ')})`
    );
  }

  return { host, username, password, version };
}
