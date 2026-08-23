import { AxlPolicyError } from './policy-error';
import { resolveMcpTlsMode, type TlsMode } from './tls-mode';
import { ALL_KNOWN_AXL_TOP_LEVEL_OBJECTS } from '../types/generated/axl-known-top-level-objects';
import { isAbsolute } from 'node:path';
import { isSupportedCucmVersion, type SupportedCucmVersion } from './version-manager';

export type AxlTopLevelObject = string;

export interface AxlMcpConfig {
  tls_mode?: string;
  tlsMode?: string;
  enabled_objects?: string[];
  enabledObjects?: string[];
  enable_sql?: boolean | number | string;
  enableSql?: boolean | number | string;
  allow_global_actions?: boolean | number | string;
  allowGlobalActions?: boolean | number | string;
  allow_inline_credentials?: boolean | number | string;
  allowInlineCredentials?: boolean | number | string;
  request_timeout_ms?: number | string;
  requestTimeoutMs?: number | string;
  client_cache_max_entries?: number | string;
  clientCacheMaxEntries?: number | string;
  credential_provider?: unknown;
  credentialProvider?: unknown;
  credential_ttl_s?: number | string;
  credentialTtlS?: number | string;
  credential_max_stale_s?: number | string;
  credentialMaxStaleS?: number | string;
  credential_provider_timeout_ms?: number | string;
  credentialProviderTimeoutMs?: number | string;
  credential_refresh_on_sighup?: boolean | number | string;
  credentialRefreshOnSighup?: boolean | number | string;
}

export interface ResolvedCredentialProviderConfig {
  readonly argv: readonly string[];
  readonly ttlMs: number;
  readonly maxStaleMs: number;
  readonly timeoutMs: number;
  readonly refreshOnSighup: boolean;
}

export interface ResolvedMcpConfig {
  readonly tlsMode: TlsMode;
  readonly sqlEnabled: boolean;
  readonly enabledObjects: ReadonlySet<AxlTopLevelObject> | null;
  readonly allowGlobalActions: boolean;
  readonly allowInlineCredentials: boolean;
  readonly requestTimeoutMs: number;
  readonly clientCacheMaxEntries: number;
  readonly credentialProvider?: ResolvedCredentialProviderConfig | null;
  readonly fixedTarget?: { readonly host: string; readonly version: SupportedCucmVersion } | null;
}

function invalidConfig(message: string): never {
  throw new AxlPolicyError('AXL_CONFIG_INVALID', message);
}

function parseConfigJson(value: string | undefined): AxlMcpConfig {
  if (value === undefined || value.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalidConfig('AXL_MCP_CONFIG must be a JSON object');
    }
    return parsed as AxlMcpConfig;
  } catch (error) {
    return invalidConfig(
      `Invalid AXL_MCP_CONFIG JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function configAliasValue(
  config: AxlMcpConfig,
  snakeCase: string,
  camelCase: string
): unknown | undefined {
  const record = config as Record<string, unknown>;
  const hasSnakeCase = Object.hasOwn(record, snakeCase);
  const hasCamelCase = Object.hasOwn(record, camelCase);
  if (hasSnakeCase && hasCamelCase) {
    return invalidConfig(
      `AXL_MCP_CONFIG must not contain both ${snakeCase} and ${camelCase}; choose one spelling`
    );
  }
  if (hasSnakeCase) return record[snakeCase];
  if (hasCamelCase) return record[camelCase];
  return undefined;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  return invalidConfig(`${field} must be one of true, false, 1, or 0`);
}

function parsePositiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') {
    return invalidConfig(`${field} must be an integer between 1 and ${maximum}`);
  }
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) {
    return invalidConfig(`${field} must be an integer between 1 and ${maximum}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    return invalidConfig(`${field} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function parseIntegerRange(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') {
    return invalidConfig(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  if (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value)) {
    return invalidConfig(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalidConfig(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseProviderArgv(value: unknown, encodedJson = false): readonly string[] {
  let parsed = value;
  if (encodedJson && typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      return invalidConfig(
        `Invalid AXL_MCP_CREDENTIAL_PROVIDER JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(item => typeof item === 'string' && item.length > 0)
  ) {
    return invalidConfig(
      'AXL_MCP_CREDENTIAL_PROVIDER must be a non-empty JSON array of non-empty strings'
    );
  }
  const argv = parsed as string[];
  const executable = argv[0];
  if (executable === undefined || !isAbsolute(executable)) {
    return invalidConfig('AXL_MCP_CREDENTIAL_PROVIDER executable path must be absolute');
  }
  return argv;
}

function environmentValue(environment: NodeJS.ProcessEnv, key: string, fallback: unknown): unknown {
  return Object.hasOwn(environment, key) ? environment[key] : fallback;
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : parseBoolean(value, field, false);
}

function parseOptionalPositiveInteger(
  value: unknown,
  field: string,
  maximum: number
): number | undefined {
  return value === undefined ? undefined : parsePositiveInteger(value, field, 1, maximum);
}

function parseOptionalTlsMode(value: unknown): TlsMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return invalidConfig('tls_mode must be a primitive string');
  try {
    return resolveMcpTlsMode({ CUCM_AXL_TLS_MODE: value });
  } catch (error) {
    return invalidConfig(error instanceof Error ? error.message : String(error));
  }
}

function parseCommaList(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseOptionalEnabledObjects(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidConfig('enabled_objects must be an array of strings');
  if (!value.every(item => typeof item === 'string')) {
    return invalidConfig('enabled_objects must contain only strings');
  }
  return value;
}

/**
 * A frozen Set still accepts add/delete calls because its elements live in
 * internal slots. Expose a snapshot through the read-only Set protocol so the
 * startup policy cannot be widened after it has been resolved.
 */
function immutableReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const snapshot = new Set(values);
  const result: ReadonlySet<T> = {
    get size() {
      return snapshot.size;
    },
    has(value) {
      return snapshot.has(value);
    },
    entries() {
      return snapshot.entries();
    },
    keys() {
      return snapshot.keys();
    },
    values() {
      return snapshot.values();
    },
    forEach(callbackfn, thisArg) {
      snapshot.forEach(value => callbackfn.call(thisArg, value, value, result));
    },
    union(other) {
      return snapshot.union(other);
    },
    intersection(other) {
      return snapshot.intersection(other);
    },
    difference(other) {
      return snapshot.difference(other);
    },
    symmetricDifference(other) {
      return snapshot.symmetricDifference(other);
    },
    isSubsetOf(other) {
      return snapshot.isSubsetOf(other);
    },
    isSupersetOf(other) {
      return snapshot.isSupersetOf(other);
    },
    isDisjointFrom(other) {
      return snapshot.isDisjointFrom(other);
    },
    [Symbol.iterator]() {
      return snapshot[Symbol.iterator]();
    },
  };
  return Object.freeze(result);
}

function parseEnabledObjectsFromArgv(argv: readonly string[]): string[] | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--enabled-objects=')) return parseCommaList(arg.split('=', 2)[1] ?? '');
    if (arg === '--enabled-objects') return parseCommaList(argv[i + 1] ?? '');
  }
  return undefined;
}

function resolveEnabledObjects(
  environment: NodeJS.ProcessEnv,
  argv: readonly string[],
  jsonEnabledObjects: readonly string[] | undefined
): ReadonlySet<AxlTopLevelObject> | null {
  const fromArgv = parseEnabledObjectsFromArgv(argv.slice(2));
  const fromEnv =
    environment.AXL_MCP_ENABLED_OBJECTS !== undefined
      ? parseCommaList(environment.AXL_MCP_ENABLED_OBJECTS)
      : undefined;
  const enabled = fromArgv ?? fromEnv ?? jsonEnabledObjects ?? [];
  if (!enabled.every(value => typeof value === 'string')) {
    return invalidConfig('enabled_objects must contain only strings');
  }
  if (enabled.length === 1 && ['*', 'all'].includes((enabled[0] ?? '').trim().toLowerCase())) {
    return null;
  }

  const valid = new Set<string>(ALL_KNOWN_AXL_TOP_LEVEL_OBJECTS);
  const selected = new Set<AxlTopLevelObject>();
  const invalid: string[] = [];
  for (const raw of enabled) {
    const key = raw.trim();
    if (!valid.has(key)) invalid.push(key);
    else selected.add(key as AxlTopLevelObject);
  }
  if (invalid.length > 0) {
    return invalidConfig(
      `Unknown enabled_objects: ${invalid.join(', ')} (see generated/axl-top-level-objects.json)`
    );
  }
  return immutableReadonlySet(selected);
}

export function loadMcpConfig(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): ResolvedMcpConfig {
  const config = parseConfigJson(environment.AXL_MCP_CONFIG);
  const jsonTlsMode = parseOptionalTlsMode(configAliasValue(config, 'tls_mode', 'tlsMode'));
  const jsonSqlEnabled = parseOptionalBoolean(
    configAliasValue(config, 'enable_sql', 'enableSql'),
    'enable_sql'
  );
  const jsonEnabledObjects = parseOptionalEnabledObjects(
    configAliasValue(config, 'enabled_objects', 'enabledObjects')
  );
  const jsonAllowGlobalActions = parseOptionalBoolean(
    configAliasValue(config, 'allow_global_actions', 'allowGlobalActions'),
    'allow_global_actions'
  );
  const jsonAllowInlineCredentials = parseOptionalBoolean(
    configAliasValue(config, 'allow_inline_credentials', 'allowInlineCredentials'),
    'allow_inline_credentials'
  );
  const jsonRequestTimeoutMs = parseOptionalPositiveInteger(
    configAliasValue(config, 'request_timeout_ms', 'requestTimeoutMs'),
    'request_timeout_ms',
    300_000
  );
  const jsonClientCacheMaxEntries = parseOptionalPositiveInteger(
    configAliasValue(config, 'client_cache_max_entries', 'clientCacheMaxEntries'),
    'client_cache_max_entries',
    256
  );
  const jsonCredentialProvider = configAliasValue(
    config,
    'credential_provider',
    'credentialProvider'
  );
  const jsonCredentialTtlS = configAliasValue(config, 'credential_ttl_s', 'credentialTtlS');
  const jsonCredentialMaxStaleS = configAliasValue(
    config,
    'credential_max_stale_s',
    'credentialMaxStaleS'
  );
  const jsonCredentialProviderTimeoutMs = configAliasValue(
    config,
    'credential_provider_timeout_ms',
    'credentialProviderTimeoutMs'
  );
  const jsonCredentialRefreshOnSighup = configAliasValue(
    config,
    'credential_refresh_on_sighup',
    'credentialRefreshOnSighup'
  );
  const parsedJsonCredentialProvider =
    jsonCredentialProvider === undefined ? undefined : parseProviderArgv(jsonCredentialProvider);
  const parsedJsonCredentialTtlS =
    jsonCredentialTtlS === undefined
      ? undefined
      : parseIntegerRange(jsonCredentialTtlS, 'credential_ttl_s', 300, 30, 86_400);
  const parsedJsonCredentialMaxStaleS =
    jsonCredentialMaxStaleS === undefined
      ? undefined
      : parseIntegerRange(jsonCredentialMaxStaleS, 'credential_max_stale_s', 0, 0, 259_200);
  const parsedJsonCredentialProviderTimeoutMs =
    jsonCredentialProviderTimeoutMs === undefined
      ? undefined
      : parseIntegerRange(
          jsonCredentialProviderTimeoutMs,
          'credential_provider_timeout_ms',
          10_000,
          100,
          60_000
        );
  const parsedJsonCredentialRefreshOnSighup =
    jsonCredentialRefreshOnSighup === undefined
      ? undefined
      : parseBoolean(
          jsonCredentialRefreshOnSighup,
          'credential_refresh_on_sighup',
          process.platform !== 'win32'
        );

  // Validate JSON object names even when an explicit CLI/environment value wins precedence.
  if (jsonEnabledObjects !== undefined) {
    resolveEnabledObjects({}, ['node', 'config-validation'], jsonEnabledObjects);
  }

  const hasEnvironmentTlsMode =
    environment.CUCM_AXL_TLS_MODE !== undefined || environment.MCP_TLS_MODE !== undefined;
  const allowInlineCredentials = parseBoolean(
    environment.AXL_MCP_ALLOW_INLINE_CREDENTIALS ?? jsonAllowInlineCredentials,
    'AXL_MCP_ALLOW_INLINE_CREDENTIALS',
    false
  );
  const providerSetting = environmentValue(
    environment,
    'AXL_MCP_CREDENTIAL_PROVIDER',
    parsedJsonCredentialProvider
  );
  const providerArgv =
    providerSetting === undefined ? undefined : parseProviderArgv(providerSetting, true);

  let credentialProvider: ResolvedCredentialProviderConfig | null = null;
  let fixedTarget: { readonly host: string; readonly version: SupportedCucmVersion } | null = null;
  if (providerArgv !== undefined) {
    if (
      Object.hasOwn(environment, 'CUCM_USERNAME') ||
      Object.hasOwn(environment, 'CUCM_PASSWORD')
    ) {
      return invalidConfig(
        'Provider mode must not be combined with CUCM_USERNAME or CUCM_PASSWORD'
      );
    }
    if (allowInlineCredentials) {
      return invalidConfig('Provider mode must not be combined with inline credentials');
    }

    const host = environment.CUCM_HOST;
    const version = environment.CUCM_VERSION;
    if (!host) return invalidConfig('Provider mode requires CUCM_HOST');
    if (!version) return invalidConfig('Provider mode requires CUCM_VERSION');
    if (!isSupportedCucmVersion(version)) {
      return invalidConfig(`Unsupported CUCM_VERSION "${version}"`);
    }

    const ttlSeconds = parseIntegerRange(
      environmentValue(environment, 'AXL_MCP_CREDENTIAL_TTL_S', parsedJsonCredentialTtlS),
      'AXL_MCP_CREDENTIAL_TTL_S',
      300,
      30,
      86_400
    );
    const maxStaleSeconds = parseIntegerRange(
      environmentValue(
        environment,
        'AXL_MCP_CREDENTIAL_MAX_STALE_S',
        parsedJsonCredentialMaxStaleS
      ),
      'AXL_MCP_CREDENTIAL_MAX_STALE_S',
      0,
      0,
      259_200
    );
    const timeoutMs = parseIntegerRange(
      environmentValue(
        environment,
        'AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS',
        parsedJsonCredentialProviderTimeoutMs
      ),
      'AXL_MCP_CREDENTIAL_PROVIDER_TIMEOUT_MS',
      10_000,
      100,
      60_000
    );
    const refreshOnSighup = parseBoolean(
      environmentValue(
        environment,
        'AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP',
        parsedJsonCredentialRefreshOnSighup
      ),
      'AXL_MCP_CREDENTIAL_REFRESH_ON_SIGHUP',
      process.platform !== 'win32'
    );

    credentialProvider = Object.freeze({
      argv: Object.freeze([...providerArgv]),
      ttlMs: ttlSeconds * 1_000,
      maxStaleMs: maxStaleSeconds * 1_000,
      timeoutMs,
      refreshOnSighup,
    });
    fixedTarget = Object.freeze({ host, version });
  }

  return Object.freeze({
    tlsMode: hasEnvironmentTlsMode ? resolveMcpTlsMode(environment) : (jsonTlsMode ?? 'secure'),
    sqlEnabled: parseBoolean(
      environment.AXL_MCP_ENABLE_SQL ?? jsonSqlEnabled,
      'AXL_MCP_ENABLE_SQL',
      false
    ),
    enabledObjects: resolveEnabledObjects(environment, argv, jsonEnabledObjects),
    allowGlobalActions: parseBoolean(
      environment.AXL_MCP_ALLOW_GLOBAL_ACTIONS ?? jsonAllowGlobalActions,
      'AXL_MCP_ALLOW_GLOBAL_ACTIONS',
      false
    ),
    allowInlineCredentials,
    requestTimeoutMs: parsePositiveInteger(
      environment.AXL_MCP_REQUEST_TIMEOUT_MS ?? jsonRequestTimeoutMs,
      'AXL_MCP_REQUEST_TIMEOUT_MS',
      30_000,
      300_000
    ),
    clientCacheMaxEntries: parsePositiveInteger(
      environment.AXL_MCP_CLIENT_CACHE_MAX_ENTRIES ?? jsonClientCacheMaxEntries,
      'AXL_MCP_CLIENT_CACHE_MAX_ENTRIES',
      16,
      256
    ),
    credentialProvider,
    fixedTarget,
  });
}

/** Compatibility accessor. New MCP code receives one immutable ResolvedMcpConfig at startup. */
export function isSqlEnabled(): boolean {
  return loadMcpConfig().sqlEnabled;
}

/** Compatibility accessor. New MCP code receives one immutable ResolvedMcpConfig at startup. */
export function getEnabledTopLevelObjects(): Set<AxlTopLevelObject> | null {
  const enabled = loadMcpConfig().enabledObjects;
  return enabled === null ? null : new Set(enabled);
}
