const diagnosticCounts = new Map<string, number>();
const MAX_DIAGNOSTIC_LINES_PER_CATEGORY = 64;

export const CREDENTIAL_DIAGNOSTIC_EVENTS = [
  'credential_refresh_started',
  'credential_refresh_unchanged',
  'credential_refresh_rotated',
  'credential_refresh_failed',
  'credential_snapshot_stale',
  'credential_snapshot_unavailable',
  'credential_generation_draining',
  'credential_generation_drained',
] as const;

export type CredentialDiagnosticEvent = (typeof CREDENTIAL_DIAGNOSTIC_EVENTS)[number];

/** Emit one of the fixed, value-free credential-source diagnostic events. */
export function emitCredentialDiagnostic(event: CredentialDiagnosticEvent): void {
  emitAxlDiagnostic(event);
}

/** Fixed, value-free stderr diagnostics with bounded per-category output. */
export function emitAxlDiagnostic(event: string): void {
  const count = diagnosticCounts.get(event) ?? 0;
  diagnosticCounts.set(event, Math.min(count + 1, MAX_DIAGNOSTIC_LINES_PER_CATEGORY));
  if (count >= MAX_DIAGNOSTIC_LINES_PER_CATEGORY) return;
  process.stderr.write(`[cisco-axl-mcp] ${event}\n`);
}
