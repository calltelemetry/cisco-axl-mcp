import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8'
);

describe('MCP TLS migration documentation contract', () => {
  it('keeps every accepted compatibility value and precedence visible to operators', () => {
    expect(readme).toContain(
      '`CUCM_AXL_TLS_MODE` → `MCP_TLS_MODE` → `AXL_MCP_CONFIG` `tls_mode`/`tlsMode` → secure default'
    );
    expect(readme).toContain('`secure`, `strict`, and `verify` enable certificate verification');
    expect(readme).toContain('`insecure` disables certificate verification');
    expect(readme).toContain(
      '`default` is a legacy compatibility alias for `insecure` and is deprecated'
    );
  });
});
