import { createHmac, randomBytes } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ResolvedMcpConfig } from './tool-config';
import { AxlPolicyError } from './policy-error';
import { emitCredentialDiagnostic, type CredentialDiagnosticEvent } from './runtime-diagnostics';
import { retireAxlClientGeneration } from './axl-client';

const PROVIDER_FAILURE_CODE = 'AXL_CREDENTIAL_PROVIDER_INVALID';
const CREDENTIALS_UNAVAILABLE_CODE = 'AXL_CREDENTIALS_UNAVAILABLE';
const PROVIDER_FAILURE_MESSAGE = 'Credential provider failed';
const CREDENTIALS_UNAVAILABLE_MESSAGE = 'Credentials unavailable';
const MAX_PROVIDER_OUTPUT_BYTES = 64 * 1024;
const MAX_CREDENTIAL_LENGTH = 512;
const CHILD_CLEANUP_GRACE_MS = 100;
const PROCESS_HMAC_KEY = randomBytes(32);

export type CredentialRefreshTrigger = 'startup' | 'ttl' | 'sighup' | 'auth-failure';

export interface CredentialMaterial {
  readonly username: string;
  readonly password: string;
}

export interface CredentialSnapshot {
  readonly material: CredentialMaterial;
  readonly generation: number;
  readonly resolvedAtMs: number;
  readonly expiresAtMs: number;
  readonly staleUntilMs: number;
  readonly identityDigest: string;
}

export interface CredentialSource {
  initialize(): Promise<CredentialSnapshot>;
  current(nowMs: number): CredentialSnapshot;
  refresh(trigger: CredentialRefreshTrigger): Promise<CredentialSnapshot>;
  shutdown(): Promise<void>;
}

export type CredentialSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface CredentialSourceHooks {
  readonly now?: () => number;
  readonly clock?: () => number;
  readonly spawn?: CredentialSpawn;
  readonly emitDiagnostic?: (event: CredentialDiagnosticEvent) => void;
  readonly onDiagnostic?: (event: CredentialDiagnosticEvent) => void;
  readonly onRetireGeneration?: (oldGeneration: number) => void;
}

function providerFailure(): AxlPolicyError {
  return new AxlPolicyError(PROVIDER_FAILURE_CODE, PROVIDER_FAILURE_MESSAGE);
}

function credentialsUnavailable(): AxlPolicyError {
  return new AxlPolicyError(CREDENTIALS_UNAVAILABLE_CODE, CREDENTIALS_UNAVAILABLE_MESSAGE);
}

function nowFrom(hooks: CredentialSourceHooks): number {
  return hooks.now?.() ?? hooks.clock?.() ?? Date.now();
}

function retainLateChildErrorSink(child: ChildProcess): void {
  const sink = (): void => undefined;
  child.on('error', sink);
  const timer = setTimeout(() => child.removeListener('error', sink), CHILD_CLEANUP_GRACE_MS);
  timer.unref?.();
}

function identityDigest(material: CredentialMaterial): string {
  return createHmac('sha256', PROCESS_HMAC_KEY)
    .update(String(Buffer.byteLength(material.username, 'utf8')))
    .update(':')
    .update(material.username, 'utf8')
    .update('\0')
    .update(String(Buffer.byteLength(material.password, 'utf8')))
    .update(':')
    .update(material.password, 'utf8')
    .digest('hex');
}

function immutableMaterial(username: string, password: string): CredentialMaterial {
  return Object.freeze({ username, password });
}

function immutableSnapshot(
  material: CredentialMaterial,
  generation: number,
  resolvedAtMs: number,
  expiresAtMs: number,
  staleUntilMs: number
): CredentialSnapshot {
  return Object.freeze({
    material,
    generation,
    resolvedAtMs,
    expiresAtMs,
    staleUntilMs,
    identityDigest: identityDigest(material),
  });
}

function staticSnapshot(
  environment: Readonly<NodeJS.ProcessEnv>,
  hooks: CredentialSourceHooks
): CredentialSnapshot {
  const username = environment.CUCM_USERNAME;
  const password = environment.CUCM_PASSWORD;
  if (!username || !password) {
    throw new AxlPolicyError('AXL_CREDENTIALS_MISSING', 'Missing CUCM_USERNAME or CUCM_PASSWORD');
  }
  const material = immutableMaterial(username, password);
  return immutableSnapshot(
    material,
    0,
    nowFrom(hooks),
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY
  );
}

function skipWhitespace(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor] ?? '')) cursor += 1;
  return cursor;
}

function consumeJsonString(value: string, index: number): number {
  if (value[index] !== '"') return -1;
  let cursor = index + 1;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === '"') return cursor + 1;
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character !== undefined && character < ' ') return -1;
    cursor += 1;
  }
  return -1;
}

function consumeJsonObject(value: string, index: number, rootKeys?: Set<string>): number {
  if (value[index] !== '{') return -1;
  const keys = new Set<string>();
  let cursor = skipWhitespace(value, index + 1);
  if (value[cursor] === '}') return cursor + 1;
  while (cursor < value.length) {
    const keyStart = cursor;
    const keyEnd = consumeJsonString(value, keyStart);
    if (keyEnd < 0) return -1;
    let key: unknown;
    try {
      key = JSON.parse(value.slice(keyStart, keyEnd)) as unknown;
    } catch {
      return -1;
    }
    if (typeof key !== 'string' || keys.has(key)) return -1;
    keys.add(key);
    if (rootKeys) rootKeys.add(key);
    cursor = skipWhitespace(value, keyEnd);
    if (value[cursor] !== ':') return -1;
    cursor = skipWhitespace(value, cursor + 1);
    cursor = consumeJsonValue(value, cursor);
    if (cursor < 0) return -1;
    cursor = skipWhitespace(value, cursor);
    if (value[cursor] === '}') return cursor + 1;
    if (value[cursor] !== ',') return -1;
    cursor = skipWhitespace(value, cursor + 1);
  }
  return -1;
}

function consumeJsonArray(value: string, index: number): number {
  if (value[index] !== '[') return -1;
  let cursor = skipWhitespace(value, index + 1);
  if (value[cursor] === ']') return cursor + 1;
  while (cursor < value.length) {
    cursor = consumeJsonValue(value, cursor);
    if (cursor < 0) return -1;
    cursor = skipWhitespace(value, cursor);
    if (value[cursor] === ']') return cursor + 1;
    if (value[cursor] !== ',') return -1;
    cursor = skipWhitespace(value, cursor + 1);
  }
  return -1;
}

function consumeJsonValue(value: string, index: number): number {
  const character = value[index];
  if (character === '"') return consumeJsonString(value, index);
  if (character === '{') return consumeJsonObject(value, index);
  if (character === '[') return consumeJsonArray(value, index);
  if (character === undefined || character === ',' || character === ']' || character === '}')
    return -1;
  let cursor = index;
  while (cursor < value.length && !',]}\r\n\t '.includes(value[cursor] ?? '')) cursor += 1;
  return cursor === index ? -1 : cursor;
}

function scanTopLevelObjectKeys(value: string): Set<string> | undefined {
  const start = skipWhitespace(value, 0);
  if (value[start] !== '{') return undefined;
  const keys = new Set<string>();
  const end = consumeJsonObject(value, start, keys);
  return end < 0 ? undefined : keys;
}

function parseProviderOutput(output: Buffer): CredentialMaterial {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw providerFailure();
  }
  const scannedKeys = scanTopLevelObjectKeys(text);
  if (!scannedKeys) throw providerFailure();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw providerFailure();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw providerFailure();
  if (Object.getPrototypeOf(parsed) !== Object.prototype) throw providerFailure();

  const keys = Object.keys(parsed);
  if (
    keys.length !== 2 ||
    keys.length !== scannedKeys.size ||
    !scannedKeys.has('username') ||
    !scannedKeys.has('password')
  ) {
    throw providerFailure();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw providerFailure();
  }

  const username = (parsed as Record<string, unknown>).username;
  const password = (parsed as Record<string, unknown>).password;
  if (typeof username !== 'string' || typeof password !== 'string') throw providerFailure();
  for (const value of [username, password]) {
    const hasControlCharacter = [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (value.length < 1 || value.length > MAX_CREDENTIAL_LENGTH || hasControlCharacter) {
      throw providerFailure();
    }
  }
  return immutableMaterial(username, password);
}

export class StaticEnvCredentialSource implements CredentialSource {
  private readonly snapshot: CredentialSnapshot;
  private shutDown = false;

  constructor(environment: Readonly<NodeJS.ProcessEnv>, hooks: CredentialSourceHooks = {}) {
    this.snapshot = staticSnapshot(environment, hooks);
  }

  initialize(): Promise<CredentialSnapshot> {
    if (this.shutDown) return Promise.reject(providerFailure());
    return Promise.resolve(this.snapshot);
  }

  current(_nowMs: number): CredentialSnapshot {
    if (this.shutDown) throw providerFailure();
    return this.snapshot;
  }

  refresh(_trigger: CredentialRefreshTrigger): Promise<CredentialSnapshot> {
    if (this.shutDown) return Promise.reject(providerFailure());
    return Promise.resolve(this.snapshot);
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
  }
}

export class CommandCredentialSource implements CredentialSource {
  private readonly providerConfig;
  private readonly hooks: CredentialSourceHooks;
  private readonly spawnProcess: CredentialSpawn;
  private snapshot: CredentialSnapshot | undefined;
  private inFlight: Promise<CredentialSnapshot> | undefined;
  private activeChild: ChildProcess | undefined;
  private activeAbort: (() => void) | undefined;
  private shutDown = false;

  constructor(config: ResolvedMcpConfig, hooks: CredentialSourceHooks = {}) {
    if (!config.credentialProvider) throw providerFailure();
    this.providerConfig = config.credentialProvider;
    this.hooks = hooks;
    this.spawnProcess =
      hooks.spawn ?? ((executable, args, options) => nodeSpawn(executable, [...args], options));
  }

  initialize(): Promise<CredentialSnapshot> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    return this.refresh('startup');
  }

  current(nowMs: number): CredentialSnapshot {
    if (this.shutDown) throw providerFailure();
    const snapshot = this.snapshot;
    if (!snapshot) throw providerFailure();
    if (nowMs < snapshot.expiresAtMs) return snapshot;
    if (nowMs < snapshot.staleUntilMs) {
      this.emit('credential_snapshot_stale');
      return snapshot;
    }
    this.emit('credential_snapshot_unavailable');
    throw credentialsUnavailable();
  }

  refresh(trigger: CredentialRefreshTrigger): Promise<CredentialSnapshot> {
    if (this.shutDown) return Promise.reject(providerFailure());
    if (this.inFlight) return this.inFlight;

    let resolveRefresh!: (snapshot: CredentialSnapshot) => void;
    let rejectRefresh!: (error: unknown) => void;
    const refreshPromise = new Promise<CredentialSnapshot>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    this.inFlight = refreshPromise;
    refreshPromise.then(
      () => {
        if (this.inFlight === refreshPromise) this.inFlight = undefined;
      },
      () => {
        if (this.inFlight === refreshPromise) this.inFlight = undefined;
      }
    );

    queueMicrotask(() => {
      if (this.shutDown) {
        rejectRefresh(providerFailure());
        return;
      }
      this.performRefresh(trigger).then(resolveRefresh, rejectRefresh);
    });
    return refreshPromise;
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
    const child = this.activeChild;
    this.activeAbort?.();
    if (child && this.activeChild === child) this.killChild(child);
    const inFlight = this.inFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // Shutdown must settle the child without exposing provider details.
      }
    }
  }

  private killChild(child: ChildProcess): void {
    if (
      'pid' in child &&
      (typeof child.pid !== 'number' || !Number.isInteger(child.pid) || child.pid <= 0)
    ) {
      const onSpawn = (): void => {
        clearTimeout(timer);
        child.removeListener('spawn', onSpawn);
        this.killChild(child);
      };
      child.once('spawn', onSpawn);
      const timer = setTimeout(
        () => child.removeListener('spawn', onSpawn),
        CHILD_CLEANUP_GRACE_MS
      );
      timer.unref?.();
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the reference and kill call.
    }
  }

  private emit(event: CredentialDiagnosticEvent): void {
    const emit = this.hooks.emitDiagnostic ?? this.hooks.onDiagnostic ?? emitCredentialDiagnostic;
    emit(event);
  }

  private async performRefresh(_trigger: CredentialRefreshTrigger): Promise<CredentialSnapshot> {
    try {
      this.emit('credential_refresh_started');
      if (this.shutDown) throw providerFailure();
      const material = await this.readProvider();
      if (this.shutDown) throw providerFailure();
      const resolvedAtMs = nowFrom(this.hooks);
      const previous = this.snapshot;
      const digest = identityDigest(material);
      const changed = previous === undefined || previous.identityDigest !== digest;
      const generation =
        previous === undefined ? 1 : changed ? previous.generation + 1 : previous.generation;
      const nextMaterial = changed ? material : previous.material;
      const snapshot = Object.freeze({
        material: nextMaterial,
        generation,
        resolvedAtMs,
        expiresAtMs: resolvedAtMs + this.providerConfig.ttlMs,
        staleUntilMs: resolvedAtMs + this.providerConfig.ttlMs + this.providerConfig.maxStaleMs,
        identityDigest: digest,
      });
      this.snapshot = snapshot;
      if (changed && previous) {
        this.emit('credential_refresh_rotated');
        this.hooks.onRetireGeneration?.(previous.generation);
      } else if (!changed) {
        this.emit('credential_refresh_unchanged');
      }
      return snapshot;
    } catch (error) {
      this.emit('credential_refresh_failed');
      if (error instanceof AxlPolicyError && error.code === PROVIDER_FAILURE_CODE) {
        throw error;
      }
      throw providerFailure();
    }
  }

  private readProvider(): Promise<CredentialMaterial> {
    const [executable, ...args] = this.providerConfig.argv;
    if (!executable) return Promise.reject(providerFailure());
    let child: ChildProcess;
    try {
      child = this.spawnProcess(executable, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return Promise.reject(providerFailure());
    }
    this.activeChild = child;
    return new Promise<CredentialMaterial>((resolve, reject) => {
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdout || !stderr) {
        retainLateChildErrorSink(child);
        this.killChild(child);
        stdout?.resume();
        stdout?.destroy();
        stderr?.resume();
        stderr?.destroy();
        this.activeChild = undefined;
        reject(providerFailure());
        return;
      }

      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      let terminationRequested = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = undefined;
        stdout.removeListener('data', onStdoutData);
        stderr.removeListener('data', onStderrData);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        retainLateChildErrorSink(child);
        stdout.resume();
        stderr.resume();
        stdout.destroy();
        stderr.destroy();
        if (this.activeChild === child) this.activeChild = undefined;
        if (this.activeAbort === failAndTerminate) this.activeAbort = undefined;
      };
      const settleFailure = (error = providerFailure()): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const settleSuccess = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(parseProviderOutput(Buffer.concat(stdoutChunks, stdoutBytes)));
        } catch {
          reject(providerFailure());
        }
      };
      const terminate = (): void => {
        if (terminationRequested) return;
        terminationRequested = true;
        this.killChild(child);
      };
      const failAndTerminate = (): void => {
        if (settled) return;
        terminate();
        settleFailure();
      };
      const onStdoutData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > MAX_PROVIDER_OUTPUT_BYTES) {
          failAndTerminate();
          return;
        }
        stdoutChunks.push(bytes);
      };
      const onStderrData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.byteLength;
        if (stderrBytes > MAX_PROVIDER_OUTPUT_BYTES) failAndTerminate();
      };
      const onError = (): void => {
        failAndTerminate();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code !== 0 || signal !== null) settleFailure();
        else settleSuccess();
      };

      stdout.on('data', onStdoutData);
      stderr.on('data', onStderrData);
      child.once('error', onError);
      child.once('close', onClose);
      this.activeAbort = failAndTerminate;
      timeout = setTimeout(failAndTerminate, this.providerConfig.timeoutMs);
      if (this.shutDown) failAndTerminate();
    });
  }
}

export function createCredentialSource(
  config: ResolvedMcpConfig,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  hooks: CredentialSourceHooks = {}
): CredentialSource {
  const effectiveHooks = hooks.onRetireGeneration
    ? hooks
    : { ...hooks, onRetireGeneration: retireAxlClientGeneration };
  return config.credentialProvider
    ? new CommandCredentialSource(config, effectiveHooks)
    : new StaticEnvCredentialSource(environment, effectiveHooks);
}
