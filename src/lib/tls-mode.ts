import { AxlPolicyError } from './policy-error';

export type TlsMode = 'secure' | 'insecure';

export interface McpTlsEnvironment {
  CUCM_AXL_TLS_MODE?: string;
  MCP_TLS_MODE?: string;
}

export function assertTlsMode(value: unknown): asserts value is TlsMode {
  if (value !== 'secure' && value !== 'insecure') {
    throw new AxlPolicyError('AXL_TLS_MODE_INVALID', `Invalid TLS mode "${String(value)}"`);
  }
}

/** Preserve compatibility only when TLS mode is genuinely unset or explicitly valid. */
export function resolveMcpTlsMode(environment: McpTlsEnvironment): TlsMode {
  const configured =
    environment.CUCM_AXL_TLS_MODE !== undefined
      ? { field: 'CUCM_AXL_TLS_MODE', value: environment.CUCM_AXL_TLS_MODE }
      : environment.MCP_TLS_MODE !== undefined
        ? { field: 'MCP_TLS_MODE', value: environment.MCP_TLS_MODE }
        : undefined;
  if (!configured) return 'secure';
  if (typeof configured.value !== 'string') {
    throw new AxlPolicyError(
      'AXL_TLS_MODE_INVALID',
      `${configured.field} must be a primitive string`
    );
  }

  const value = configured.value.trim().toLowerCase();
  if (value === 'default' || value === 'insecure') return 'insecure';
  if (value === 'secure' || value === 'strict' || value === 'verify') return 'secure';
  throw new AxlPolicyError(
    'AXL_TLS_MODE_INVALID',
    `${configured.field} must be one of default, insecure, secure, strict, or verify`
  );
}
