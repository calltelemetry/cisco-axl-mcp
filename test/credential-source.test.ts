import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { loadMcpConfig, type ResolvedMcpConfig } from '../src/lib/tool-config';
import { createCredentialSource, type CredentialSourceHooks } from '../src/lib/credential-source';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-credential-source-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(name: string, body: string): string {
  const fixturePath = join(tempDir, name);
  writeFileSync(fixturePath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  chmodSync(fixturePath, 0o700);
  return fixturePath;
}

function writeJsonFixture(name: string, value: string, suffix = ''): string {
  return writeFixture(name, `process.stdout.write(${JSON.stringify(value)});${suffix}`);
}

function providerConfig(
  fixturePath: string,
  options: {
    ttlS?: number;
    maxStaleS?: number;
    timeoutMs?: number;
  } = {}
): ResolvedMcpConfig {
  const env: NodeJS.ProcessEnv = {
    CUCM_HOST: 'fixed.example.test',
    CUCM_VERSION: '11.5',
    AXL_MCP_CREDENTIAL_PROVIDER: JSON.stringify([fixturePath]),
    AXL_MCP_CREDENTIAL_TTL_S: String(options.ttlS ?? 30),
    AXL_MCP_CREDENTIAL_MAX_STALE_S: String(options.maxStaleS ?? 0),
    AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS: String(options.timeoutMs ?? 1_000),
    AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP: 'false',
  };
  return loadMcpConfig(env, ['node', 'test']);
}

function staticConfig(): ResolvedMcpConfig {
  return loadMcpConfig(
    {
      CUCM_HOST: 'static.example.test',
      CUCM_VERSION: '14.0',
    },
    ['node', 'test']
  );
}

function realSpawn(
  command: string,
  args: readonly string[],
  options: Parameters<typeof nodeSpawn>[2]
): ChildProcess {
  return nodeSpawn(command, [...args], options);
}

function hooks(now: () => number, events: string[], spawn = realSpawn): CredentialSourceHooks {
  return {
    now,
    spawn,
    emitDiagnostic: event => events.push(event),
  };
}

describe('StaticEnvCredentialSource', () => {
  it('snapshots static environment credentials once at generation zero', async () => {
    const env: NodeJS.ProcessEnv = {
      CUCM_HOST: 'static.example.test',
      CUCM_VERSION: '14.0',
      CUCM_USERNAME: 'static-user',
      CUCM_PASSWORD: 'static-password',
    };
    const source = createCredentialSource(staticConfig(), env);

    const first = await source.initialize();
    env.CUCM_HOST = 'changed.example.test';
    env.CUCM_VERSION = '15.0';
    env.CUCM_USERNAME = 'changed-user';
    env.CUCM_PASSWORD = 'changed-password';

    expect(first.generation).toBe(0);
    expect(first.material).toEqual({ username: 'static-user', password: 'static-password' });
    expect(source.current(Date.now())).toBe(first);
    expect(await source.refresh('ttl')).toBe(first);
    await source.shutdown();
  });
});

describe('CommandCredentialSource', () => {
  it('creates an immutable startup snapshot with exact expiry and stale timestamps', async () => {
    const fixture = writeJsonFixture(
      'startup.js',
      '{"username":"provider-user","password":"provider-password"}'
    );
    const now = 10_000;
    const events: string[] = [];
    const source = createCredentialSource(
      providerConfig(fixture, { ttlS: 30, maxStaleS: 20 }),
      {},
      hooks(() => now, events)
    );

    const snapshot = await source.initialize();

    expect(snapshot).toMatchObject({
      generation: 1,
      resolvedAtMs: 10_000,
      expiresAtMs: 40_000,
      staleUntilMs: 60_000,
    });
    expect(snapshot.material).toEqual({
      username: 'provider-user',
      password: 'provider-password',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.material)).toBe(true);
    expect(events).toContain('credential_refresh_started');
    await source.shutdown();
  });

  it('renews timestamps without changing generation when material is unchanged', async () => {
    const fixture = writeJsonFixture(
      'unchanged.js',
      '{"username":"same-user","password":"same-password"}'
    );
    let now = 1_000;
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(() => now, [])
    );
    const first = await source.initialize();
    now = 2_000;

    const refreshed = await source.refresh('ttl');

    expect(refreshed.generation).toBe(1);
    expect(refreshed.identityDigest).toBe(first.identityDigest);
    expect(refreshed.resolvedAtMs).toBe(2_000);
    expect(refreshed.expiresAtMs).toBe(32_000);
    expect(refreshed.staleUntilMs).toBe(32_000);
    expect(refreshed).not.toBe(first);
    await source.shutdown();
  });

  it('rotates changed material and retires the previous generation once', async () => {
    const fixture = writeJsonFixture(
      'rotate.js',
      '{"username":"old-user","password":"old-password"}'
    );
    let now = 1_000;
    const retired: number[] = [];
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      {
        ...hooks(() => now, []),
        onRetireGeneration: generation => retired.push(generation),
      }
    );
    const first = await source.initialize();
    writeJsonFixture('rotate.js', '{"username":"new-user","password":"new-password"}');
    now = 2_000;

    const refreshed = await source.refresh('sighup');

    expect(refreshed.generation).toBe(2);
    expect(refreshed.material).toEqual({ username: 'new-user', password: 'new-password' });
    expect(refreshed.identityDigest).not.toBe(first.identityDigest);
    expect(retired).toEqual([1]);
    await source.shutdown();
  });

  it('shares one in-flight refresh across concurrent callers and child processes', async () => {
    const fixture = writeFixture(
      'single-flight.js',
      `setTimeout(() => process.stdout.write('{"username":"flight-user","password":"flight-password"}'), 100);`
    );
    let spawnCalls = 0;
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(
        () => 1_000,
        [],
        (command, args, options) => {
          spawnCalls += 1;
          return realSpawn(command, args, options);
        }
      )
    );

    const first = source.refresh('startup');
    const second = source.refresh('sighup');
    const [left, right] = await Promise.all([first, second]);

    expect(left).toBe(right);
    expect(spawnCalls).toBe(1);
    await source.shutdown();
  });

  it('starts the provider with direct argv, isolated stdio, and no shell', async () => {
    const fixture = writeJsonFixture(
      'argv.js',
      '{"username":"argv-user","password":"argv-password"}'
    );
    let invocation:
      | {
          command: string;
          args: readonly string[];
          options: Parameters<typeof nodeSpawn>[2];
        }
      | undefined;
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(
        () => 1_000,
        [],
        (command, args, options) => {
          invocation = { command, args, options };
          return realSpawn(command, args, options);
        }
      )
    );

    await source.initialize();

    expect(invocation).toMatchObject({
      command: fixture,
      args: [],
      options: {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    });
    await source.shutdown();
  });

  it.each([
    ['nonzero exit', 'process.stderr.write("stderr-secret"); process.exit(7);'],
    ['signal exit', 'process.kill(process.pid, "SIGTERM");'],
    ['malformed JSON', 'process.stdout.write("malformed-secret");'],
    [
      'duplicate decoded keys',
      'process.stdout.write("{\\"user\\u006eame\\":\\"user-secret\\",\\"username\\":\\"other-secret\\",\\"password\\":\\"password-secret\\"}");',
    ],
    [
      'unknown keys',
      'process.stdout.write("{\\"username\\":\\"user-secret\\",\\"password\\":\\"password-secret\\",\\"host\\":\\"host-secret\\"}");',
    ],
    ['array', 'process.stdout.write("[\\"user-secret\\",\\"password-secret\\"]");'],
    [
      'empty value',
      'process.stdout.write("{\\"username\\":\\"\\",\\"password\\":\\"password-secret\\"}");',
    ],
    [
      'control character',
      'process.stdout.write("{\\"username\\":\\"user\\u0001secret\\",\\"password\\":\\"password-secret\\"}");',
    ],
    [
      'over-sized value',
      'process.stdout.write(JSON.stringify({username: "u".repeat(513), password: "password-secret"}));',
    ],
    [
      'trailing data',
      'process.stdout.write("{\\"username\\":\\"user-secret\\",\\"password\\":\\"password-secret\\"} trailing-secret");',
    ],
  ])('rejects provider output on %s without exposing fixture values', async (_name, body) => {
    const fixture = writeFixture('invalid.js', body);
    const events: string[] = [];
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(() => 1_000, events)
    );

    const failure = await source.initialize().catch(error => error);

    expect(failure).toMatchObject({ code: 'AXL_CREDENTIAL_PROVIDER_FAILED' });
    expect(String(failure)).toBe('AxlPolicyError: Credential provider failed');
    expect(String(failure)).not.toMatch(
      /user-secret|other-secret|password-secret|stderr-secret|host-secret|trailing-secret|malformed-secret/
    );
    expect(events).toContain('credential_refresh_failed');
    await source.shutdown();
  });

  it('rejects a provider that exceeds the stdout byte cap', async () => {
    const stdoutSecret = 'stdout-cap-secret';
    const fixture = writeFixture(
      'stdout-cap.js',
      `process.stdout.write(${JSON.stringify(stdoutSecret)} + 'x'.repeat(65536));`
    );
    const events: string[] = [];
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(() => 1_000, events)
    );

    const failure = await source.initialize().catch(error => error);

    expect(failure).toMatchObject({ code: 'AXL_CREDENTIAL_PROVIDER_FAILED' });
    expect(String(failure)).not.toContain(stdoutSecret);
    expect(events).toContain('credential_refresh_failed');
    await source.shutdown();
  });

  it('rejects a provider that exceeds the stderr byte cap', async () => {
    const stderrSecret = 'stderr-cap-secret';
    const fixture = writeFixture(
      'stderr-cap.js',
      `process.stderr.write(${JSON.stringify(stderrSecret)} + 'x'.repeat(65536));`
    );
    const source = createCredentialSource(
      providerConfig(fixture),
      {},
      hooks(() => 1_000, [])
    );

    const failure = await source.initialize().catch(error => error);

    expect(failure).toMatchObject({ code: 'AXL_CREDENTIAL_PROVIDER_FAILED' });
    expect(String(failure)).not.toContain(stderrSecret);
    await source.shutdown();
  });

  it('returns a failed-refresh snapshot only while it is within staleUntilMs', async () => {
    const fixture = writeJsonFixture(
      'stale.js',
      '{"username":"stale-user","password":"stale-password"}'
    );
    let now = 1_000;
    const source = createCredentialSource(
      providerConfig(fixture, { ttlS: 30, maxStaleS: 10 }),
      {},
      hooks(() => now, [])
    );
    const first = await source.initialize();
    writeFileSync(fixture, '#!/usr/bin/env node\nprocess.exit(2);\n');
    chmodSync(fixture, 0o700);
    now = 31_001;

    await expect(source.refresh('ttl')).rejects.toMatchObject({
      code: 'AXL_CREDENTIAL_PROVIDER_FAILED',
    });
    expect(source.current(now)).toBe(first);
    now = 41_001;
    expect(() => source.current(now)).toThrowError(
      expect.objectContaining({ code: 'AXL_CREDENTIALS_UNAVAILABLE' })
    );
    await source.shutdown();
  });

  it('fails immediately after expiry when maximum stale is zero', async () => {
    const fixture = writeJsonFixture(
      'strict-stale.js',
      '{"username":"strict-user","password":"strict-password"}'
    );
    let now = 1_000;
    const source = createCredentialSource(
      providerConfig(fixture, { maxStaleS: 0 }),
      {},
      hooks(() => now, [])
    );
    await source.initialize();
    writeFileSync(fixture, '#!/usr/bin/env node\nprocess.exit(2);\n');
    chmodSync(fixture, 0o700);
    now = 31_001;

    await expect(source.refresh('ttl')).rejects.toMatchObject({
      code: 'AXL_CREDENTIAL_PROVIDER_FAILED',
    });
    expect(() => source.current(now)).toThrowError(
      expect.objectContaining({ code: 'AXL_CREDENTIALS_UNAVAILABLE' })
    );
    await source.shutdown();
  });

  it('kills and fully settles an in-flight child during shutdown', async () => {
    const fixture = writeFixture('shutdown.js', 'setInterval(() => {}, 1000);');
    const source = createCredentialSource(
      providerConfig(fixture, { timeoutMs: 5_000 }),
      {},
      hooks(() => 1_000, [])
    );
    const inFlight = source.refresh('startup');
    await new Promise(resolve => setTimeout(resolve, 100));

    const shutdownStarted = Date.now();
    await source.shutdown();
    await expect(inFlight).rejects.toMatchObject({ code: 'AXL_CREDENTIAL_PROVIDER_FAILED' });
    await expect(source.refresh('ttl')).rejects.toMatchObject({
      code: 'AXL_CREDENTIAL_PROVIDER_FAILED',
    });
    expect(Date.now() - shutdownStarted).toBeLessThan(2_000);
  });
});
