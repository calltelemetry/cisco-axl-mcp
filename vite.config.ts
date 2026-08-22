import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

const packageMetadata = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const packageDependencies = Object.keys(packageMetadata.dependencies);

function isExternal(id: string): boolean {
  return (
    builtinModules.includes(id) ||
    id.startsWith('node:') ||
    packageDependencies.some(dependency => id === dependency || id.startsWith(`${dependency}/`))
  );
}

export default defineConfig(({ mode }) => ({
  build: {
    lib: {
      entry: {
        index: resolve(projectRoot, 'src/bin/mcp.ts'),
        cli: resolve(projectRoot, 'src/bin/cli.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: isExternal,
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    target: 'node18',
    // Development maps stay local; release packs contain executable runtime code only.
    sourcemap: mode === 'development',
    outDir: 'build',
  },
}));
