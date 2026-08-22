import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('MCP runtime bundle', () => {
  it('loads generated AXL version payloads only through lazy version chunks', async () => {
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
    const chunks = outputs.filter(output => output.type === 'chunk');
    const entry = chunks.find(output => output.isEntry && output.fileName === 'index.js');
    if (!entry || entry.type !== 'chunk') throw new Error('Missing MCP entry chunk');

    const chunksByFileName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
    const mcpRuntimeChunks = new Set<typeof entry>();
    const visitStaticImports = (chunk: typeof entry): void => {
      if (mcpRuntimeChunks.has(chunk)) return;
      mcpRuntimeChunks.add(chunk);
      for (const importedFile of chunk.imports) {
        const importedChunk = chunksByFileName.get(importedFile);
        if (importedChunk) visitStaticImports(importedChunk);
      }
    };
    visitStaticImports(entry);

    const bundledVersionModules = [...mcpRuntimeChunks]
      .flatMap(chunk => Object.keys(chunk.modules))
      .filter(moduleId => moduleId.includes('/types/generated/versions/axl-version-'))
      .map(moduleId => moduleId.split('/').at(-1));
    const mcpRuntimeCode = [...mcpRuntimeChunks].map(chunk => chunk.code).join('\n');

    expect(bundledVersionModules).toEqual([]);
    expect(
      chunks
        .flatMap(chunk => Object.keys(chunk.modules))
        .filter(moduleId => moduleId.includes('/types/generated/versions/axl-version-'))
    ).toHaveLength(6);
    expect(mcpRuntimeCode).not.toContain('Cisco CTL Provider');
    expect(Buffer.byteLength(mcpRuntimeCode)).toBeLessThan(10_000_000);
  }, 120_000);
});
