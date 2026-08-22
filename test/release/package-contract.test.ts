import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS, V8_COVERAGE_EXCLUSIONS } from '../../vitest.config';

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
      main?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.repository).toBe('https://github.com/calltelemetry/cisco-axl-mcp.git');
    expect(packageJson.engines).toEqual({ node: '>=22.14.0' });
    expect(packageJson.bin).toEqual({
      'cisco-axl-mcp': 'build/index.js',
      'cisco-axl-mcp-cli': 'build/cli.js',
    });
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.dependencies).not.toHaveProperty('@types/node');
    expect(packageJson.devDependencies).toHaveProperty('@types/node');
    expect(packageJson.peerDependencies).toBeUndefined();
    expect(packageJson.scripts?.['package:smoke']).toBe('vitest run test/package-build.test.ts');
    expect(packageJson.scripts?.validate).toBe(
      'yarn typecheck && yarn format:check && yarn lint --max-warnings=0 && yarn vitest run --coverage && yarn build && yarn package:smoke'
    );
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
    const publishStart = release.indexOf('\n  publish:');
    const publishJob = publishStart < 0 ? '' : release.slice(publishStart);

    expect(read('.github/workflows/publish.yml')).toBe('');
    expect(release).toContain(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'
    );
    expect(release).toContain(
      'googleapis/release-please-action@8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5'
    );
    expect(release).toContain('RELEASE_APP_CLIENT_ID');
    expect(release).toContain('RELEASE_APP_PRIVATE_KEY');
    expect(release).toContain('client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}');
    expect(release).not.toContain('app-id:');
    expect(publishJob).toContain('environment: npm');
    expect(publishJob).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);
    expect(release).toContain('package-manager-cache: false');
    expect(release).toContain('node-version-file: .nvmrc');
    expect(release).toContain('npm install --global npm@11.5.1');
    expect(release).toContain('yarn install --immutable');
    expect(release).toContain('yarn package:smoke');
    expect(release).toContain('npm publish --access public --provenance');
    expect(release).toMatch(
      /ref: refs\/tags\/\$\{\{ needs\.release-please\.outputs\.tag_name \}\}/
    );
    expect(release).toMatch(/RELEASE_TAG: \$\{\{ needs\.release-please\.outputs\.tag_name \}\}/);
    expect(release).toContain('git rev-parse "refs/tags/${RELEASE_TAG}^{commit}"');
    expect(release).toContain('test "$(git rev-parse HEAD)" = "$tag_commit"');
    expect(publishJob).toContain(
      [
        'run: test "$(node -p \'require("',
        './package.json',
        '").version\')" = "${RELEASE_TAG#v}"',
      ].join('')
    );

    const checkout = publishJob.indexOf('actions/checkout@');
    const tagVerification = publishJob.indexOf(
      'Verify checked-out tag before running repository commands'
    );
    const setupNode = publishJob.indexOf('actions/setup-node@');
    const versionVerification = publishJob.indexOf(
      'Verify exact release version before dependencies'
    );
    const npmInstall = publishJob.indexOf('npm install --global npm@11.5.1');
    const corepack = publishJob.indexOf('corepack enable');
    const yarnInstall = publishJob.indexOf('yarn install --immutable');

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(tagVerification).toBeGreaterThan(checkout);
    expect(setupNode).toBeGreaterThan(tagVerification);
    expect(versionVerification).toBeGreaterThan(setupNode);
    expect(npmInstall).toBeGreaterThan(versionVerification);
    expect(corepack).toBeGreaterThan(versionVerification);
    expect(yarnInstall).toBeGreaterThan(versionVerification);
    for (const repositoryCommand of [
      'yarn typecheck',
      'yarn lint --max-warnings=50',
      'yarn test',
      'yarn build',
      'npm pack --dry-run',
      'yarn package:smoke',
    ]) {
      expect(publishJob.indexOf(repositoryCommand)).toBeGreaterThan(versionVerification);
    }
    expect(release).not.toContain('NPM_TOKEN');
    expect(release).not.toContain('NODE_AUTH_TOKEN');
    expect(ci).toContain('yarn validate');
  });

  it('makes the strict local validation contract the CI gate', () => {
    const ci = read('.github/workflows/ci.yml');
    const vitestConfig = read('vitest.config.ts');

    expect(ci).toContain('yarn install --immutable');
    expect(ci).toContain('run: yarn validate');
    expect(ci).not.toContain('--max-warnings=50');
    expect(ci).not.toContain('--max-warnings=');
    expect(vitestConfig).toMatch(/thresholds:\s*\{[\s\S]*branches:\s*\d+/);
    expect(vitestConfig).toMatch(/thresholds:\s*\{[\s\S]*functions:\s*\d+/);
    expect(vitestConfig).toMatch(/thresholds:\s*\{[\s\S]*lines:\s*\d+/);
    expect(vitestConfig).toMatch(/thresholds:\s*\{[\s\S]*statements:\s*\d+/);
  });

  it('limits V8 exclusions to generated, adapter, and package-tested subprocess boundaries', () => {
    expect(SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS).toEqual([
      'src/bin/cli.ts',
      'src/bin/mcp.ts',
      'src/bin/metadata.ts',
      'src/lib/entrypoint.ts',
    ]);
    expect(V8_COVERAGE_EXCLUSIONS).toEqual([
      'src/types/generated/**',
      'src/**/*.d.ts',
      ...SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS,
    ]);

    const packageTest = read('test/package-build.test.ts');
    const packageEvidence: Record<string, readonly string[]> = {
      'src/bin/cli.ts': [
        "['build/cli.js', '--help'",
        "['build/cli.js', '--version'",
        "executableName('cisco-axl-mcp-cli')",
      ],
      'src/bin/mcp.ts': [
        "['build/index.js', '--help'",
        "['build/index.js', '--version'",
        'rejects malformed MCP configuration before loading a forbidden runtime dependency',
        'runs installed MCP stdio with JSON-only stdout',
      ],
      'src/bin/metadata.ts': [
        'runs installed %s metadata flags without configuration or protocol output',
        'runs %s %s without loading runtime-only dependencies',
      ],
      'src/lib/entrypoint.ts': [
        'keeps both built bootstrap modules import-safe without a runtime import contract',
        'runs installed %s metadata flags without configuration or protocol output',
      ],
    };

    expect(Object.keys(packageEvidence)).toEqual([...SUBPROCESS_ONLY_COVERAGE_EXCLUSIONS]);
    for (const evidence of Object.values(packageEvidence)) {
      for (const marker of evidence) expect(packageTest).toContain(marker);
    }
  });

  it('uses the exact .nvmrc runtime for validation, release, and scheduled audit', () => {
    const workflows = [
      read('.github/workflows/ci.yml'),
      read('.github/workflows/release.yml'),
      read('.github/workflows/scheduled-audit.yml'),
    ];

    expect(read('.nvmrc').trim()).toBe('22.14.0');
    for (const workflow of workflows) {
      expect(workflow).toContain('node-version-file: .nvmrc');
      expect(workflow).not.toMatch(/node-version:\s*['"]?22['"]?/);
    }
  });

  it('runs a non-mutating dependency audit every week', () => {
    const audit = read('.github/workflows/scheduled-audit.yml');

    expect(audit).toContain('schedule:');
    expect(audit).toContain('cron:');
    expect(audit).toContain('workflow_dispatch:');
    expect(audit).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(audit).toContain('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
    expect(audit).toContain('yarn install --immutable');
    expect(audit).toContain('yarn npm audit --all --recursive');
    expect(audit).not.toMatch(/gh\s+pr\s+create|create-pull-request|git\s+push/i);
  });
});
