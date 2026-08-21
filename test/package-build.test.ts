import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableName = (name: string): string =>
  process.platform === 'win32' ? `${name}.cmd` : name;

interface PackageMetadata {
  name: string;
  version: string;
  bin: Record<string, string>;
}

interface InstalledPackage {
  root: string;
  metadata: PackageMetadata;
}

interface PackageArtifacts {
  buildRoot: string;
  packedRoot: string;
  installed: InstalledPackage;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DEBUG;
  delete env.CUCM_PASSWORD;
  delete env.CUCM_USERNAME;
  return env;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: 'utf8',
    env: options.env ?? commandEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
}

function expectCommandSuccess(result: SpawnSyncReturns<string>): void {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

async function importBuiltEntry(
  entryPath: string,
  exportName: string
): Promise<SpawnSyncReturns<string>> {
  const source = [
    `const entry = await import(${JSON.stringify(pathToFileURL(entryPath).href)});`,
    `if (typeof entry[${JSON.stringify(exportName)}] !== 'function') throw new Error('missing export');`,
    `process.stdout.write('imported\\n');`,
  ].join(' ');
  return run(process.execPath, ['--input-type=module', '--eval', source], { timeout: 5_000 });
}

async function initializeMcp(binaryPath: string): Promise<{
  response: Record<string, unknown>;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPath, [], {
      cwd: workspaceRoot,
      env: commandEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolvePromise({ response: response!, stdout, stderr });
    };

    const timeout = setTimeout(
      () => finish(new Error(`MCP initialize timed out. stdout=${stdout} stderr=${stderr}`)),
      10_000
    );

    child.on('error', error => finish(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 1) finish(undefined, message);
        } catch {
          finish(new Error(`MCP stdout contained non-JSON data: ${JSON.stringify(line)}`));
        }
      }
    });

    child.stdin.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'package-build-test', version: '1.0.0' },
        },
      })}\n`
    );
  });
}

describe('published package distribution', () => {
  let tempRoot: string;
  let artifacts: PackageArtifacts;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'cisco-axl-package-'));

    const tarball = join(tempRoot, 'cisco-axl-mcp.tgz');
    const previousUmask = process.umask(0o000);
    try {
      const build = run('yarn', ['build']);
      expectCommandSuccess(build);

      const pack = run('yarn', ['pack', '--filename', tarball]);
      expectCommandSuccess(pack);
    } finally {
      process.umask(previousUmask);
    }

    const packedRoot = join(tempRoot, 'packed');
    await mkdir(packedRoot);
    const extract = run('tar', ['-xzf', tarball, '-C', packedRoot]);
    expectCommandSuccess(extract);

    const installRoot = join(tempRoot, 'consumer');
    await mkdir(installRoot);
    const installEnvironment = commandEnvironment();
    installEnvironment.HOME = tempRoot;
    installEnvironment.NPM_CONFIG_USERCONFIG = join(tempRoot, '.npmrc');
    installEnvironment.NPM_CONFIG_CACHE = join(tempRoot, 'npm-cache');
    const install = run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
      { cwd: installRoot, env: installEnvironment }
    );
    expectCommandSuccess(install);

    const packageRoot = join(installRoot, 'node_modules', '@calltelemetry', 'cisco-axl-mcp');
    artifacts = {
      buildRoot: workspaceRoot,
      packedRoot: join(packedRoot, 'package'),
      installed: {
        root: packageRoot,
        metadata: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
      },
    };
  }, 180_000);

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('publishes explicit MCP and CLI executable bins with shebangs', async () => {
    expect(artifacts.installed.metadata.bin).toEqual({
      'cisco-axl-mcp': 'build/index.js',
      'cisco-axl': 'build/cli.js',
    });

    for (const entry of Object.values(artifacts.installed.metadata.bin)) {
      for (const root of [artifacts.buildRoot, artifacts.packedRoot, artifacts.installed.root]) {
        const entryPath = join(root, entry);
        expect(await readFile(entryPath, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
        if (process.platform !== 'win32') {
          expect((await stat(entryPath)).mode & 0o777).toBe(0o755);
        }
      }
    }
  });

  it('keeps both built entry modules import-safe', async () => {
    const entries = [
      ['build/index.js', 'startMcp'],
      ['build/cli.js', 'runCli'],
    ] as const;
    for (const [entry, exportName] of entries) {
      const imported = await importBuiltEntry(join(artifacts.installed.root, entry), exportName);
      expectCommandSuccess(imported);
      expect(imported.stdout).toBe('imported\n');
      expect(imported.stderr).toBe('');
    }
  });

  it('runs the installed CLI as one JSON-envelope stdout document', () => {
    const cli = join(
      dirname(dirname(artifacts.installed.root)),
      '.bin',
      executableName('cisco-axl')
    );
    const result = run(cli, ['versions']);
    expectCommandSuccess(result);
    expect(result.stderr).toBe('');

    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schema_version: 'cisco-axl.cli.v1',
      ok: true,
      data: { versions: expect.any(Array) },
    });
  });

  it('runs installed MCP stdio with JSON-only stdout and package metadata version', async () => {
    const mcp = join(
      dirname(dirname(artifacts.installed.root)),
      '.bin',
      executableName('cisco-axl-mcp')
    );
    const initialized = await initializeMcp(mcp);

    const stdoutLines = initialized.stdout.trim().split('\n');
    expect(stdoutLines).toHaveLength(1);
    expect(() => JSON.parse(stdoutLines[0]!)).not.toThrow();
    expect(initialized.response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: {
          name: 'cisco-axl-mcp',
          version: artifacts.installed.metadata.version,
        },
      },
    });
  }, 20_000);
});
