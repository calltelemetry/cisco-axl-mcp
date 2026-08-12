import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('MCP runtime bundle', () => {
  it('retains only the latest generated AXL version payload', async () => {
    const result = await build({
      configFile: new URL('../vite.config.ts', import.meta.url).pathname,
      logLevel: 'silent',
      build: {
        write: false,
        sourcemap: false,
      },
    });
    if ('on' in result) throw new Error('Unexpected watch build');

    const outputs = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
    const entry = outputs.find(output => output.type === 'chunk' && output.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Missing MCP entry chunk');

    const bundledVersionModules = Object.keys(entry.modules)
      .filter(moduleId => moduleId.includes('/types/generated/versions/axl-version-'))
      .map(moduleId => moduleId.split('/').at(-1));

    expect(bundledVersionModules).toEqual(['axl-version-15-0.ts']);
    expect(entry.code).not.toContain('Cisco CTL Provider');
    expect(Buffer.byteLength(entry.code)).toBeLessThan(10_000_000);
  }, 120_000);
});
