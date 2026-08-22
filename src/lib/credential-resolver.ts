import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isSupportedCucmVersion, SUPPORTED_CUCM_VERSIONS } from './version-manager';
import type { CucmCredentials, ToolCredentialOverrides } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';

export interface CredentialResolutionOptions {
  /** Compatibility-only support for model-visible per-request CUCM credentials. */
  allowInlineCredentials?: boolean;
}

export class CredentialResolutionError extends McpError {
  constructor(
    public readonly kind: 'missing' | 'unsupported',
    message: string
  ) {
    super(ErrorCode.InvalidParams, message);
    this.name = 'CredentialResolutionError';
  }
}

export function resolveCredentials(
  overrides: ToolCredentialOverrides,
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialResolutionOptions = {}
): CucmCredentials {
  if (
    !options.allowInlineCredentials &&
    (overrides.cucm_host !== undefined ||
      overrides.cucm_username !== undefined ||
      overrides.cucm_password !== undefined)
  ) {
    throw new AxlPolicyError(
      'AXL_INLINE_CREDENTIALS_DISABLED',
      'Inline CUCM credentials are disabled; configure CUCM_HOST, CUCM_USERNAME, and CUCM_PASSWORD in the MCP host environment'
    );
  }
  const host = overrides.cucm_host ?? env.CUCM_HOST;
  const username = overrides.cucm_username ?? env.CUCM_USERNAME;
  const password = overrides.cucm_password ?? env.CUCM_PASSWORD;
  const version = overrides.cucm_version ?? env.CUCM_VERSION;

  if (!host) throw new CredentialResolutionError('missing', 'Missing CUCM_HOST or cucm_host');
  if (!username)
    throw new CredentialResolutionError('missing', 'Missing CUCM_USERNAME or cucm_username');
  if (!password)
    throw new CredentialResolutionError('missing', 'Missing CUCM_PASSWORD or cucm_password');
  if (!version)
    throw new CredentialResolutionError('missing', 'Missing CUCM_VERSION or cucm_version');

  if (!isSupportedCucmVersion(version)) {
    throw new CredentialResolutionError(
      'unsupported',
      `Unsupported cucm_version "${version}" (supported: ${SUPPORTED_CUCM_VERSIONS.join(', ')})`
    );
  }

  return { host, username, password, version };
}
