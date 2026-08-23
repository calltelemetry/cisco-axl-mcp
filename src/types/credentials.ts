/** Opaque in-process binding between one credential source and its clients. */
export const CREDENTIAL_SCOPE = Symbol('cisco-axl-mcp-credential-scope');
export type CredentialScope = object;

export interface CucmCredentials {
  host: string;
  username: string;
  password: string;
  version: string;
  /** Provider-mode admission generation; static and CLI callers omit it. */
  readonly credentialGeneration?: number;
  /** Internal, non-enumerable provider-source binding; never part of MCP data. */
  readonly [CREDENTIAL_SCOPE]?: CredentialScope;
}

export interface ToolCredentialOverrides {
  cucm_host?: string;
  cucm_username?: string;
  cucm_password?: string;
  cucm_version?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : undefined;
}
