import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteCli = resolve(repositoryRoot, 'node_modules/vite/bin/vite.js');

describe('production build warning contract', () => {
  it('does not emit Vite native-config-loader warnings', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'cisco-axl-build-warning-'));
    const output = await (async () => {
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [viteCli, 'build', '--outDir', outputRoot],
          {
            cwd: repositoryRoot,
            maxBuffer: 1024 * 1024,
          }
        );
        return `${stdout}\n${stderr}`;
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    })();

    expect(output).not.toContain('Vite config uses features that are unsupported');
    expect(output).not.toContain("configLoader: 'native'");
  }, 30_000);
});
