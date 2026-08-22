import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8'
);

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
});
