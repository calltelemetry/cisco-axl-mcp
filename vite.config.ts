import { defineConfig } from 'vite';
import { resolve } from 'path';
import { builtinModules } from 'module';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        'cisco-axl',
        '@modelcontextprotocol/sdk/server/index.js',
        '@modelcontextprotocol/sdk/server/stdio.js',
        '@modelcontextprotocol/sdk/types.js',
        ...builtinModules,
        ...builtinModules.map(m => `node:${m}`),
        'dotenv',
        'strong-soap',
      ],
    },
    target: 'node18',
    sourcemap: true,
    outDir: 'build',
  },
});

