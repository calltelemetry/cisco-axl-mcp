import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string): string => {
  const path = resolve(repositoryRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const readme = read('README.md');
const claude = read('CLAUDE.md');
const envExample = read('.env.example');

describe('MCP tools documentation contract', () => {
  it('keeps the advertised tool count and preview wording aligned with the tool table', () => {
    const tableStart = readme.indexOf('| Tool ');
    const tableEnd = readme.indexOf('**Built-in resilience:**', tableStart);
    const toolTable = readme.slice(tableStart, tableEnd);
    const listedTools = [...toolTable.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]);

    expect(listedTools).toEqual([
      'axl_execute',
      'axl_preview_mutation',
      'axl_describe_operation',
      'axl_list_objects',
      'axl_list_operations',
      'axl_list_action_operations',
      'axl_sql_query',
      'axl_sql_update',
    ]);
    expect(readme).toContain('Eight composable tools give the LLM progressive disclosure');
    expect(readme).toContain('Exposes eight composable tools that let an LLM discover');
    expect(readme).not.toMatch(/\bseven\b/i);
  });

  it('documents the complete single-target credential-provider contract', () => {
    expect(readme).toContain('Credential provider mode');
    for (const setting of [
      'AXL_MCP_CREDENTIAL_PROVIDER',
      'AXL_MCP_CREDENTIAL_TTL_S',
      'AXL_MCP_CREDENTIAL_MAX_STALE_S',
      'AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS',
      'AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP',
    ]) {
      expect(readme).toContain(setting);
      expect(envExample).toContain(setting);
    }

    expect(readme).toMatch(
      /\[\s*"\/absolute\/path\/to\/provider"\s*,\s*"--asset-id"\s*,\s*"lab-cucm"\s*\]/
    );
    expect(readme).toContain('{"username":"<username>","password":"<password>"}');
    expect(readme).toMatch(/single[ -]target/);
    expect(readme).toMatch(/target.{0,200}(?:immutable|cannot be changed)/is);
    expect(readme).toContain('CUCM_VERSION');
    expect(readme).toContain('11.5');
    expect(readme).toMatch(
      /static credentials.{0,120}provider|provider.{0,120}static credentials/is
    );
    expect(readme).toMatch(/TTL.{0,120}primary/is);
    expect(readme).toMatch(/SIGHUP.{0,120}optional/is);
    expect(readme).toMatch(/stale.{0,120}(?:bounded|maximum|fail closed)/is);
    expect(readme).toMatch(/generation.{0,120}drain/is);
    expect(readme).toContain('transport evidence is insufficient');
    expect(readme).toMatch(/does not\s+\n?retry authentication/i);
    expect(readme).toContain('AXL_CREDENTIALS_UNAVAILABLE');
    expect(claude).not.toContain('Any tool may override via `cucm_host`');
    expect(claude).toContain('single fixed target');
    expect(claude).toMatch(/no\s+credential(?:-management MCP)? tools/i);
  });

  it('does not add an MCP credential-management tool or expose provider values', () => {
    expect(readme).not.toMatch(/^\|\s*`axl_(?:credential|rotate|refresh)/im);
    const providerStart = readme.indexOf('Credential provider mode');
    expect(providerStart).toBeGreaterThanOrEqual(0);
    const providerSection = readme.slice(
      providerStart,
      readme.indexOf('\n### ', providerStart + 4)
    );
    expect(providerSection).not.toContain('axl_password');
    expect(envExample).not.toMatch(/^CUCM_PASSWORD\s*=\s*[^#\s]/m);
  });
});
