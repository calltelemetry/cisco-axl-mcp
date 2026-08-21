import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  const path = resolve(repositoryRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('public npm release contract', () => {
  it('declares the existing npm version and trusted-publishing metadata', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      bin?: Record<string, string>;
      engines?: Record<string, string>;
      private?: boolean;
      repository?: string;
      scripts?: Record<string, string>;
      version: string;
    };

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.repository).toBe('https://github.com/calltelemetry/cisco-axl-mcp.git');
    expect(packageJson.engines).toEqual({ node: '>=22.14.0', npm: '>=11.5.1' });
    expect(packageJson.bin).toEqual({
      'cisco-axl-mcp': 'build/index.js',
      'cisco-axl': 'build/cli.js',
    });
    expect(packageJson.scripts?.['package:smoke']).toBe('vitest run test/package-build.test.ts');
  });

  it('starts release-please from the already-published npm version', () => {
    const releaseConfigText = read('release-please-config.json');
    const manifestText = read('.release-please-manifest.json');
    expect(releaseConfigText).not.toBe('');
    expect(manifestText).not.toBe('');

    const releaseConfig = JSON.parse(releaseConfigText || '{}') as {
      packages?: Record<string, { 'package-name'?: string; 'release-type'?: string }>;
    };
    const manifest = JSON.parse(manifestText || '{}') as Record<string, string>;

    expect(releaseConfig.packages?.['.']).toMatchObject({
      'package-name': '@calltelemetry/cisco-axl-mcp',
      'release-type': 'node',
    });
    const packageJson = JSON.parse(read('package.json')) as { version: string };
    expect(manifest['.']).toBe(packageJson.version);
    expect(read('.nvmrc').trim()).toBe('22.14.0');
    expect(read('.releaserc.json')).toBe('');
  });

  it('publishes exact release tags through GitHub OIDC without an npm token', () => {
    const release = read('.github/workflows/release.yml');
    const ci = read('.github/workflows/ci.yml');

    expect(read('.github/workflows/publish.yml')).toBe('');
    expect(release).toContain(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'
    );
    expect(release).toContain(
      'googleapis/release-please-action@8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5'
    );
    expect(release).toContain('RELEASE_APP_ID');
    expect(release).toContain('RELEASE_APP_PRIVATE_KEY');
    expect(release).toContain('environment: npm');
    expect(release).toContain('id-token: write');
    expect(release).toContain('package-manager-cache: false');
    expect(release).toContain('npm install --global npm@11.5.1');
    expect(release).toContain('yarn install --immutable');
    expect(release).toContain('yarn package:smoke');
    expect(release).toContain('npm publish --access public');
    expect(release).not.toContain('--provenance');
    expect(release).not.toContain('NPM_TOKEN');
    expect(release).not.toContain('NODE_AUTH_TOKEN');
    expect(ci).toContain('yarn package:smoke');
  });
});
