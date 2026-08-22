import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executableName = (name: string): string =>
  process.platform === 'win32' ? `${name}.cmd` : name;
const npmCliPath = join(
  dirname(dirname(process.execPath)),
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js'
);

interface PackageMetadata {
  name: string;
  version: string;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
}

interface InstalledPackage {
  root: string;
  metadata: PackageMetadata;
}

interface PackMetadata {
  filename: string;
  files: Array<{ path: string }>;
  size: number;
  unpackedSize: number;
}

interface PackageArtifacts {
  buildRoot: string;
  packedRoot: string;
  installed: InstalledPackage;
  pack: PackMetadata;
  loaderPath: string;
}

const MAP_FREE_COMPRESSED_BASELINE_BYTES = 2_045_856;
const MAP_FREE_UNPACKED_BASELINE_BYTES = 29_733_335;
// Baseline + 10%, rounded upward to whole MiB: 3 MiB compressed / 32 MiB unpacked.
const MAX_COMPRESSED_BYTES = 3 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const PACKED_CONTENTS_BASELINE =
  `Map-free baseline=${MAP_FREE_COMPRESSED_BASELINE_BYTES} compressed / ` +
  `${MAP_FREE_UNPACKED_BASELINE_BYTES} unpacked; ceilings=${MAX_COMPRESSED_BYTES} compressed / ` +
  `${MAX_UNPACKED_BYTES} unpacked (baseline + 10%, rounded up to MiB).`;

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

async function importBuiltBootstrap(entryPath: string): Promise<SpawnSyncReturns<string>> {
  const source = [
    `const entry = await import(${JSON.stringify(pathToFileURL(entryPath).href)});`,
    `if (Object.keys(entry).length !== 0) throw new Error('bootstrap exposes runtime exports');`,
    `process.stdout.write('imported\\n');`,
  ].join(' ');
  return run(process.execPath, ['--input-type=module', '--eval', source], { timeout: 5_000 });
}

function runMetadataLoaderProbe(
  entryPath: string,
  loaderPath: string,
  flag: '--help' | '--version'
): SpawnSyncReturns<string> {
  return run(
    process.execPath,
    ['--no-warnings', '--experimental-loader', pathToFileURL(loaderPath).href, entryPath, flag],
    {
      env: {
        ...commandEnvironment(),
        AXL_MCP_CONFIG: '{invalid-json',
        REJECT_DOTENV: 'true',
      },
      timeout: 10_000,
    }
  );
}

function runMalformedMcpConfigLoaderProbe(
  entryPath: string,
  loaderPath: string
): SpawnSyncReturns<string> {
  return run(
    process.execPath,
    ['--no-warnings', '--experimental-loader', pathToFileURL(loaderPath).href, entryPath],
    { env: { ...commandEnvironment(), AXL_MCP_CONFIG: '{invalid-json' }, timeout: 10_000 }
  );
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

async function listMcpTools(
  binaryPath: string,
  cwd: string
): Promise<{ response: Record<string, unknown>; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binaryPath, [], {
      cwd,
      env: commandEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let initialized = false;
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
      () => finish(new Error(`MCP tools/list timed out. stdout=${stdout} stderr=${stderr}`)),
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
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (line === '') continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          finish(new Error(`MCP stdout contained non-JSON data: ${JSON.stringify(line)}`));
          return;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/list',
              params: {},
            })}\n`
          );
        } else if (message.id === 2) {
          finish(undefined, message);
          return;
        }
      }
    });

    child.stdin.write(
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

    const previousUmask = process.umask(0o000);
    let packMetadata: PackMetadata | undefined;
    try {
      const pack = run(process.execPath, [
        npmCliPath,
        'pack',
        '--json',
        '--pack-destination',
        tempRoot,
      ]);
      expectCommandSuccess(pack);
      const jsonStart = Math.max(
        pack.stdout.lastIndexOf('\n['),
        pack.stdout.lastIndexOf('\r['),
        pack.stdout.lastIndexOf('[\n  {'),
        pack.stdout.lastIndexOf('\n{'),
        pack.stdout.lastIndexOf('\r{')
      );
      expect(jsonStart).not.toBe(-1);
      const jsonOutput =
        pack.stdout[jsonStart] === '['
          ? pack.stdout.slice(jsonStart)
          : pack.stdout.slice(jsonStart + 1);
      const parsed = JSON.parse(jsonOutput) as PackMetadata[] | Record<string, PackMetadata>;
      const metadata = Array.isArray(parsed) ? parsed : Object.values(parsed);
      expect(metadata).toHaveLength(1);
      [packMetadata] = metadata;
    } finally {
      process.umask(previousUmask);
    }
    if (!packMetadata) throw new Error('npm pack did not provide package metadata');
    const tarball = join(tempRoot, packMetadata.filename);

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
      process.execPath,
      [
        npmCliPath,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        tarball,
      ],
      { cwd: installRoot, env: installEnvironment }
    );
    expectCommandSuccess(install);

    const packageRoot = join(installRoot, 'node_modules', '@calltelemetry', 'cisco-axl-mcp');
    const loaderPath = join(tempRoot, 'reject-runtime-loader.mjs');
    await writeFile(
      loaderPath,
      [
        "const forbidden = new Set(['cisco-axl']);",
        "if (process.env.REJECT_DOTENV === 'true') forbidden.add('dotenv/config');",
        'export async function resolve(specifier, context, nextResolve) {',
        "  if (forbidden.has(specifier) || specifier.startsWith('@modelcontextprotocol/sdk')) {",
        '    throw new Error(`FORBIDDEN_RUNTIME_IMPORT:${specifier}`);',
        '  }',
        '  return nextResolve(specifier, context);',
        '}',
      ].join('\n')
    );
    artifacts = {
      buildRoot: workspaceRoot,
      packedRoot: join(packedRoot, 'package'),
      pack: packMetadata,
      loaderPath,
      installed: {
        root: packageRoot,
        metadata: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
      },
    };
  }, 180_000);

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it('publishes only explicit MCP and CLI executable bins with shebangs', async () => {
    expect(artifacts.installed.metadata.bin).toEqual({
      'cisco-axl-mcp': 'build/index.js',
      'cisco-axl-mcp-cli': 'build/cli.js',
    });
    expect(artifacts.installed.metadata.main).toBeUndefined();
    expect(artifacts.installed.metadata.dependencies).not.toHaveProperty('@types/node');
    expect(artifacts.installed.metadata.devDependencies).toHaveProperty('@types/node');
    expect(artifacts.installed.metadata.peerDependencies).toBeUndefined();

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

  it('keeps both built bootstrap modules import-safe without a runtime import contract', async () => {
    for (const entry of ['build/index.js', 'build/cli.js']) {
      const imported = await importBuiltBootstrap(join(artifacts.installed.root, entry));
      expectCommandSuccess(imported);
      expect(imported.stdout).toBe('imported\n');
      expect(imported.stderr).toBe('');
    }
  });

  it.each([
    ['cisco-axl-mcp', 'Cisco AXL MCP server'],
    ['cisco-axl-mcp-cli', 'Cisco AXL command-line client'],
  ])(
    'runs installed %s metadata flags without configuration or protocol output',
    (binary, label) => {
      const cli = join(dirname(dirname(artifacts.installed.root)), '.bin', executableName(binary));
      const malformedConfig = { ...commandEnvironment(), AXL_MCP_CONFIG: '{invalid-json' };
      const help = run(cli, ['--help'], { env: malformedConfig });
      expectCommandSuccess(help);
      expect(help.stdout).toContain(label);
      expect(help.stdout).not.toContain('{"jsonrpc"');
      expect(help.stderr).toBe('');
      if (binary === 'cisco-axl-mcp-cli') {
        expect(help.stdout).toContain('--confirm sql-query');
        expect(help.stdout).toContain('--confirm sql-update');
      }

      const version = run(cli, ['--version'], { env: malformedConfig });
      expectCommandSuccess(version);
      expect(version.stdout.trim()).toBe(artifacts.installed.metadata.version);
      expect(version.stderr).toBe('');
    }
  );

  it('loads normal MCP policy from an installed-package .env while metadata ignores it', async () => {
    const cwd = await mkdtemp(join(tempRoot, 'dotenv-startup-'));
    await writeFile(join(cwd, '.env'), 'AXL_MCP_ENABLE_SQL=true\n');
    const mcp = join(
      dirname(dirname(artifacts.installed.root)),
      '.bin',
      executableName('cisco-axl-mcp')
    );

    try {
      const metadata = run(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-loader',
          pathToFileURL(artifacts.loaderPath).href,
          join(artifacts.installed.root, 'build/index.js'),
          '--help',
        ],
        {
          cwd,
          env: { ...commandEnvironment(), REJECT_DOTENV: 'true' },
          timeout: 10_000,
        }
      );
      expectCommandSuccess(metadata);
      expect(metadata.stderr).toBe('');

      const listed = await listMcpTools(mcp, cwd);
      expect(listed.stderr).not.toContain('AXL_CONFIG_INVALID');
      expect(listed.response).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'axl_sql_query' }),
            expect.objectContaining({ name: 'axl_sql_update' }),
          ]),
        },
      });
      expect(listed.stdout.trim().split('\n')).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('loads installed CLI version selection from .env while CLI metadata ignores it', async () => {
    const cwd = await mkdtemp(join(tempRoot, 'dotenv-cli-'));
    await writeFile(join(cwd, '.env'), 'CUCM_VERSION=15.0\n');
    const cli = join(
      dirname(dirname(artifacts.installed.root)),
      '.bin',
      executableName('cisco-axl-mcp-cli')
    );
    const normalEnvironment = commandEnvironment();
    delete normalEnvironment.CUCM_VERSION;

    try {
      const metadata = run(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-loader',
          pathToFileURL(artifacts.loaderPath).href,
          join(artifacts.installed.root, 'build/cli.js'),
          '--help',
        ],
        {
          cwd,
          env: { ...normalEnvironment, REJECT_DOTENV: 'true' },
          timeout: 10_000,
        }
      );
      expectCommandSuccess(metadata);
      expect(metadata.stderr).toBe('');

      const result = run(cli, ['objects'], { cwd, env: normalEnvironment });
      expectCommandSuccess(result);
      expect(result.stderr).toBe('');
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        schema_version: 'cisco-axl.cli.v1',
        ok: true,
        meta: { command: 'objects', cucm_version: '15.0' },
        data: { objects: expect.any(Array) },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects malformed MCP configuration before loading a forbidden runtime dependency', () => {
    const result = runMalformedMcpConfigLoaderProbe(
      join(artifacts.installed.root, 'build/index.js'),
      artifacts.loaderPath
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AXL_CONFIG_INVALID');
    expect(result.stderr).not.toContain('FORBIDDEN_RUNTIME_IMPORT');
    expect(result.stdout).toBe('');
  });

  it.each([
    ['build/index.js', '--help', 'Cisco AXL MCP server'],
    ['build/index.js', '--version', undefined],
    ['build/cli.js', '--help', 'Cisco AXL command-line client'],
    ['build/cli.js', '--version', undefined],
  ] as const)(
    'runs %s %s without loading runtime-only dependencies',
    (entry, flag, expectedHelpText) => {
      const result = runMetadataLoaderProbe(
        join(artifacts.installed.root, entry),
        artifacts.loaderPath,
        flag
      );
      expectCommandSuccess(result);
      expect(result.stderr).toBe('');
      if (expectedHelpText === undefined) {
        expect(result.stdout.trim()).toBe(artifacts.installed.metadata.version);
      } else {
        expect(result.stdout).toContain(expectedHelpText);
      }
    }
  );

  it('runs the installed CLI as one JSON-envelope stdout document', () => {
    const cli = join(
      dirname(dirname(artifacts.installed.root)),
      '.bin',
      executableName('cisco-axl-mcp-cli')
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

  it('excludes source maps from the packed tarball', async () => {
    const packageFiles = await (
      await import('node:fs/promises')
    ).readdir(artifacts.packedRoot, {
      recursive: true,
    });
    expect(packageFiles.filter(file => file.endsWith('.map'))).toEqual([]);
  });

  it('keeps the shared real npm pack artifact within permanent map-free ceilings', () => {
    expect(artifacts.pack.files.some(file => file.path.endsWith('.map'))).toBe(false);
    expect(
      artifacts.pack.size,
      `${PACKED_CONTENTS_BASELINE} compressed=${artifacts.pack.size}`
    ).toBeLessThanOrEqual(MAX_COMPRESSED_BYTES);
    expect(
      artifacts.pack.unpackedSize,
      `${PACKED_CONTENTS_BASELINE} unpacked=${artifacts.pack.unpackedSize}`
    ).toBeLessThanOrEqual(MAX_UNPACKED_BYTES);
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
