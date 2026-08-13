import { defineConfig } from 'vite';
import { resolve } from 'path';
import { builtinModules } from 'module';
import { readFileSync } from 'fs';

const packageMetadata = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
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

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
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
    sourcemap: true,
    outDir: 'build',
  },
});
