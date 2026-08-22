const diagnosticCounts = new Map<string, number>();
const MAX_DIAGNOSTIC_LINES_PER_CATEGORY = 64;

/** Fixed, value-free stderr diagnostics with bounded per-category output. */
export function emitAxlDiagnostic(event: string): void {
  const count = diagnosticCounts.get(event) ?? 0;
  diagnosticCounts.set(event, Math.min(count + 1, MAX_DIAGNOSTIC_LINES_PER_CATEGORY));
  if (count >= MAX_DIAGNOSTIC_LINES_PER_CATEGORY) return;
  process.stderr.write(`[cisco-axl-mcp] ${event}\n`);
}
