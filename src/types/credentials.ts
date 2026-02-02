export interface CucmCredentials {
  host: string;
  username: string;
  password: string;
  version: string;
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

