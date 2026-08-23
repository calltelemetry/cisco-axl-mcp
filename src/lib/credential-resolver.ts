import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isSupportedCucmVersion, SUPPORTED_CUCM_VERSIONS } from './version-manager';
import type { CucmCredentials, ToolCredentialOverrides } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';
import type { CredentialSource } from './credential-source';
import type { ResolvedMcpConfig } from './tool-config';
import { CREDENTIAL_SCOPE } from '../types/credentials';

export interface AxlToolRuntime {
  readonly credentialSource: CredentialSource;
  readonly startupEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly now: () => number;
}

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

function assertProviderVersion(
  requested: unknown,
  fixedVersion: string
): asserts requested is string | undefined {
  if (requested === undefined) return;
  if (typeof requested !== 'string' || requested !== fixedVersion) {
    throw new AxlPolicyError(
      'AXL_TARGET_VERSION_DRIFT',
      `Provider mode is pinned to CUCM ${fixedVersion}`
    );
  }
}

async function currentAdmittedSnapshot(
  runtime: AxlToolRuntime
): Promise<Awaited<ReturnType<CredentialSource['current']>>> {
  const now = runtime.now();
  let snapshot;
  try {
    snapshot = runtime.credentialSource.current(now);
  } catch {
    return runtime.credentialSource.refresh('ttl');
  }

  if (now < snapshot.expiresAtMs) return snapshot;
  try {
    return await runtime.credentialSource.refresh('ttl');
  } catch {
    // A failed refresh may still leave the last snapshot admissible through
    // its configured maximum-stale window.
    return runtime.credentialSource.current(now);
  }
}

/** Resolve exactly one immutable credential snapshot at MCP request admission. */
export async function resolveAdmittedCredentials(
  overrides: ToolCredentialOverrides,
  config: ResolvedMcpConfig,
  runtime: AxlToolRuntime
): Promise<CucmCredentials> {
  if (config.credentialProvider && config.fixedTarget) {
    if (
      overrides.cucm_host !== undefined ||
      overrides.cucm_username !== undefined ||
      overrides.cucm_password !== undefined
    ) {
      throw new AxlPolicyError(
        'AXL_INLINE_CREDENTIALS_DISABLED',
        'Inline CUCM credentials are disabled; configure the credential provider at MCP startup'
      );
    }
    assertProviderVersion(overrides.cucm_version, config.fixedTarget.version);
    const snapshot = await currentAdmittedSnapshot(runtime);
    const admitted = {
      host: config.fixedTarget.host,
      username: snapshot.material.username,
      password: snapshot.material.password,
      version: config.fixedTarget.version,
      credentialGeneration: snapshot.generation,
    } as CucmCredentials;
    const scope = snapshot[CREDENTIAL_SCOPE];
    if (scope) {
      Object.defineProperty(admitted, CREDENTIAL_SCOPE, {
        value: scope,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(admitted);
  }

  return Object.freeze(
    resolveCredentials(overrides, runtime.startupEnvironment, {
      allowInlineCredentials: config.allowInlineCredentials,
    })
  );
}
