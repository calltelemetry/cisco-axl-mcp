import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AxlPolicyError } from '../types/axl/errors';
import { isSupportedCucmVersion } from './version-manager';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import { assertTlsMode, type ExecuteOperationOptions, type TlsMode } from './axl-client';
import { CREDENTIAL_SCOPE, type CucmCredentials } from '../types/credentials';
import { isMutationOperation } from './operation-classification-core';

export {
  isMutationOperation,
  isMutationOperationForVersion,
  isMutationOperationFromCatalog,
} from './operation-classification-core';

export interface MutationGrantRequest {
  credentials: CucmCredentials;
  tlsMode: TlsMode;
  operation: string;
  data: unknown;
  opts?: ExecuteOperationOptions;
  autoPage?: boolean;
}

export interface MutationGrant {
  readonly id: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Opaque, authority-keyed endpoint/principal bindings. Never clear credentials. */
  readonly target: {
    readonly endpointDigest: string;
    readonly principalDigest: string;
    readonly version: string;
  };
  readonly operation: string;
  readonly requestDigest: string;
  readonly schemaDigest: string;
  readonly packageVersion: string;
  readonly provenance: string;
}

type UnsignedMutationGrant = Omit<MutationGrant, 'provenance'>;

const READ_ONLY_SQL_QUERY_OPERATIONS = new Set(['executeSQLQuery', 'executeSQLQueryInactive']);

const UNSIGNED_GRANT_FIELDS = [
  'id',
  'issuedAt',
  'expiresAt',
  'target',
  'operation',
  'requestDigest',
  'schemaDigest',
  'packageVersion',
] as const;
const GRANT_FIELDS = [...UNSIGNED_GRANT_FIELDS, 'provenance'] as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VERSION_PATTERN = /^\d+(?:\.\d+)+$/;

function invalidGrant(field: string, reason: string): never {
  throw new AxlPolicyError(
    'AXL_MUTATION_GRANT_INVALID',
    `Mutation grant ${field} is invalid: ${reason}`
  );
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function readPlainDataRecord(
  value: unknown,
  field: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidGrant(field, 'must be a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidGrant(field, 'symbol properties are not allowed');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const wanted = [...expectedKeys].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    invalidGrant(field, 'has missing or unexpected fields');
  }

  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalidGrant(`${field}.${key}`, 'must be an enumerable data property');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requiredString(value: unknown, field: string, maxLength = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    invalidGrant(field, 'must be a non-empty trimmed primitive string');
  }
  return value;
}

function timestampString(value: unknown, field: string): string {
  const timestamp = requiredString(value, field, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    invalidGrant(field, 'must be an ISO-8601 UTC timestamp');
  }
  return timestamp;
}

function digestString(value: unknown, field: string): string {
  const digest = requiredString(value, field, 64);
  if (!SHA256_HEX_PATTERN.test(digest)) {
    invalidGrant(field, 'must be a lowercase SHA-256 digest');
  }
  return digest;
}

function validateUnsignedGrant(value: unknown): UnsignedMutationGrant {
  const grant = readPlainDataRecord(value, 'object', UNSIGNED_GRANT_FIELDS);
  const target = readPlainDataRecord(grant.target, 'target', [
    'endpointDigest',
    'principalDigest',
    'version',
  ]);
  const id = requiredString(grant.id, 'id', 256);
  if (!OPAQUE_ID_PATTERN.test(id)) invalidGrant('id', 'has an unsupported format');
  const version = requiredString(target.version, 'target.version', 32);
  if (!VERSION_PATTERN.test(version)) invalidGrant('target.version', 'has an unsupported format');

  return Object.freeze({
    id,
    issuedAt: timestampString(grant.issuedAt, 'issuedAt'),
    expiresAt: timestampString(grant.expiresAt, 'expiresAt'),
    target: Object.freeze({
      endpointDigest: digestString(target.endpointDigest, 'target.endpointDigest'),
      principalDigest: digestString(target.principalDigest, 'target.principalDigest'),
      version,
    }),
    operation: requiredString(grant.operation, 'operation', 256),
    requestDigest: digestString(grant.requestDigest, 'requestDigest'),
    schemaDigest: digestString(grant.schemaDigest, 'schemaDigest'),
    packageVersion: requiredString(grant.packageVersion, 'packageVersion', 128),
  });
}

function validateGrant(value: unknown): MutationGrant {
  const grant = readPlainDataRecord(value, 'object', GRANT_FIELDS);
  const unsigned = validateUnsignedGrant(
    Object.fromEntries(UNSIGNED_GRANT_FIELDS.map(field => [field, grant[field]]))
  );
  return Object.freeze({
    ...unsigned,
    provenance: digestString(grant.provenance, 'provenance'),
  });
}

function provenancePayload(grant: UnsignedMutationGrant): string {
  return JSON.stringify([
    grant.id,
    grant.issuedAt,
    grant.expiresAt,
    grant.target?.endpointDigest,
    grant.target?.principalDigest,
    grant.target?.version,
    grant.operation,
    grant.requestDigest,
    grant.schemaDigest,
    grant.packageVersion,
  ]);
}

export class MutationGrantAuthority {
  private readonly key: Buffer;

  constructor(key: Uint8Array = randomBytes(32)) {
    if (key.byteLength < 32) {
      throw new AxlPolicyError(
        'AXL_MUTATION_GRANT_AUTHORITY_INVALID',
        'Mutation grant authority keys must contain at least 32 bytes'
      );
    }
    this.key = Buffer.from(key);
  }

  sign(grant: UnsignedMutationGrant): string {
    const validated = validateUnsignedGrant(grant);
    return createHmac('sha256', this.key).update(provenancePayload(validated)).digest('hex');
  }

  verify(grant: MutationGrant): boolean {
    const validated = validateGrant(grant);
    const expected = Buffer.from(
      createHmac('sha256', this.key).update(provenancePayload(validated)).digest('hex'),
      'hex'
    );
    const received = Buffer.from(validated.provenance, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  /**
   * Produces non-reversible bindings without retaining host, username, or
   * password in the grant. The principal digest uses the exact username passed
   * to transport; only password rotation remains valid by design.
   */
  targetFor(credentials: CucmCredentials): MutationGrant['target'] {
    const endpoint = normalizedHost(credentials.host);
    const username = credentials.username;
    const digest = (scope: string, value: string): string =>
      createHmac('sha256', this.key).update(`${scope}\u0000${value}`).digest('hex');
    return Object.freeze({
      endpointDigest: digest('endpoint', endpoint),
      principalDigest: digest('principal', `${endpoint}\u0000${username}`),
      version: credentials.version,
    });
  }
}

const defaultMutationGrantAuthority = new MutationGrantAuthority();

export interface CreateMutationGrantOptions {
  request: MutationGrantRequest;
  packageVersion: string;
  expiresAt: string;
  id?: string;
}

export class MutationGrantReplayStore {
  private readonly consumedIds = new Map<string, number>();

  constructor(private readonly maxEntries = 4_096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new AxlPolicyError(
        'AXL_MUTATION_GRANT_REPLAY_CAPACITY_INVALID',
        'Mutation grant replay capacity must be a positive integer'
      );
    }
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.consumedIds) {
      if (expiresAt <= now) this.consumedIds.delete(id);
    }
  }

  consume(id: string, expiresAt: number, now = Date.now()): boolean {
    this.prune(now);
    if (this.consumedIds.has(id)) return false;
    if (this.consumedIds.size >= this.maxEntries) {
      throw new AxlPolicyError(
        'AXL_MUTATION_GRANT_REPLAY_CAPACITY',
        'Mutation grant replay capacity is exhausted; wait for prior grants to expire'
      );
    }
    this.consumedIds.set(id, expiresAt);
    return true;
  }

  clear(): void {
    this.consumedIds.clear();
  }

  get size(): number {
    return this.consumedIds.size;
  }
}

export const defaultMutationGrantReplayStore = new MutationGrantReplayStore();

export function clearMutationGrantReplayStore(): void {
  defaultMutationGrantReplayStore.clear();
}

function normalizedHost(host: string): string {
  return host.trim().toLowerCase();
}

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface NormalizedMutationGrantRequest extends MutationGrantRequest {
  operation: string;
  data: { readonly [key: string]: JsonValue };
}

export function normalizeAxlOperation(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AxlPolicyError('AXL_OPERATION_INVALID', 'AXL operation must be a primitive string');
  }
  const operation = value.trim();
  if (!operation || operation.length > 256 || hasControlCharacters(operation)) {
    throw new AxlPolicyError(
      'AXL_OPERATION_INVALID',
      'AXL operation must be a non-empty string without control characters'
    );
  }
  return operation;
}

export function isReadOnlySqlQueryOperation(operation: string): boolean {
  return READ_ONLY_SQL_QUERY_OPERATIONS.has(operation);
}

/**
 * Replaces quoted content with inert placeholders while rejecting every
 * supported Informix comment form. This deliberately recognizes only simple
 * quoted strings and identifiers, leaving statement classification to a very
 * small safe subset.
 */
function sqlCodeWithoutCommentsOrLiterals(sql: string): string | null {
  let result = '';
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < sql.length; index++) {
    const character = sql[index] ?? '';
    const next = sql[index + 1] ?? '';
    if (quote) {
      result += ' ';
      if (character === quote) {
        if (next === quote) {
          result += ' ';
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += '?';
      continue;
    }
    if (
      (character === '-' && next === '-') ||
      (character === '/' && next === '*') ||
      (character === '*' && next === '/') ||
      character === '{' ||
      character === '}'
    ) {
      return null;
    }
    result += character;
  }

  return quote ? null : result;
}

const SQL_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_$]*(?:\\.[A-Za-z_][A-Za-z0-9_$]*)?';
const SQL_VALUE = `(?:${SQL_IDENTIFIER}|\\?|\\d+)`;
const SQL_PROJECTION = `(?:\\*|${SQL_VALUE})(?:\\s+as\\s+${SQL_IDENTIFIER})?`;
const SQL_COMPARISON = `${SQL_VALUE}\\s*(?:=|!=|<>|<=|>=|<|>)\\s*${SQL_VALUE}`;
const SAFE_SIMPLE_SELECT = new RegExp(
  `^\\s*select\\s+${SQL_PROJECTION}(?:\\s*,\\s*${SQL_PROJECTION})*` +
    `(?:\\s+from\\s+${SQL_IDENTIFIER}(?:\\s+(?:as\\s+)?${SQL_IDENTIFIER})?` +
    `(?:\\s+where\\s+${SQL_COMPARISON}(?:\\s+(?:and|or)\\s+${SQL_COMPARISON})*)?` +
    `(?:\\s+order\\s+by\\s+${SQL_IDENTIFIER}(?:\\s+(?:asc|desc))?` +
    `(?:\\s*,\\s*${SQL_IDENTIFIER}(?:\\s+(?:asc|desc))?)*)?` +
    `(?:\\s+limit\\s+\\d+)?)?\\s*$`,
  'i'
);

function isSafeSimpleSelect(statement: string): boolean {
  if (/\b(?:nextval|currval|sequence|udr|spl)\b/i.test(statement)) return false;
  if (/[()]/.test(statement)) return false;
  return SAFE_SIMPLE_SELECT.test(statement);
}

/**
 * Conservative guard for the read-only SQL tool. It intentionally accepts only
 * one SELECT statement and rejects syntax that would require a SQL parser to
 * classify safely. CUCM remains the final enforcement layer.
 */
export function assertReadOnlySqlQuery(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AxlPolicyError(
      'AXL_SQL_QUERY_NOT_READ_ONLY',
      'SQL query payload must contain one read-only SELECT statement'
    );
  }
  const sql = (data as Record<string, unknown>).sql;
  if (typeof sql !== 'string') {
    throw new AxlPolicyError(
      'AXL_SQL_QUERY_NOT_READ_ONLY',
      'SQL query payload must contain one read-only SELECT statement'
    );
  }
  const statement = sqlCodeWithoutCommentsOrLiterals(sql);
  if (!statement) {
    throw new AxlPolicyError(
      'AXL_SQL_QUERY_NOT_READ_ONLY',
      'SQL query tool accepts only one read-only SELECT statement'
    );
  }
  const trimmed = statement.trimEnd();
  const terminalSemicolon = trimmed.lastIndexOf(';');
  const withoutTerminator =
    terminalSemicolon === trimmed.length - 1 ? trimmed.slice(0, -1).trimEnd() : trimmed;
  const containsWriteOrProcedureForm =
    /\b(?:insert|update|delete|merge|replace|create|alter|drop|truncate|grant|revoke|call|exec(?:ute)?|procedure|begin|commit|rollback|into|for\s+update)\b/i.test(
      withoutTerminator
    );
  if (
    !withoutTerminator.trim() ||
    containsWriteOrProcedureForm ||
    (terminalSemicolon >= 0 && terminalSemicolon !== trimmed.length - 1) ||
    withoutTerminator.includes(';') ||
    !isSafeSimpleSelect(withoutTerminator)
  ) {
    throw new AxlPolicyError(
      'AXL_SQL_QUERY_NOT_READ_ONLY',
      'SQL query tool accepts only one read-only SELECT statement'
    );
  }
}

function invalidJson(path: string, reason: string): never {
  throw new AxlPolicyError(
    'AXL_MUTATION_GRANT_REQUEST_INVALID',
    `Mutation request ${path} is not plain JSON-safe data: ${reason}`
  );
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>()
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJson(path, 'numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    invalidJson(path, `unsupported ${typeof value} value`);
  }
  if (typeof value !== 'object') invalidJson(path, `unsupported ${typeof value} value`);
  if (ancestors.has(value)) invalidJson(path, 'cycles are not allowed');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        invalidJson(path, 'symbol properties are not allowed');
      }
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
        invalidJson(path, 'arrays cannot have custom properties');
      }
      const enumerableKeys = Object.keys(value);
      if (
        enumerableKeys.length !== value.length ||
        enumerableKeys.some((key, index) => key !== String(index))
      ) {
        invalidJson(path, 'arrays must be dense and cannot have custom properties');
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          invalidJson(`${path}[${index}]`, 'accessors and non-enumerable values are not allowed');
        }
        result.push(normalizeJsonValue(descriptor.value, `${path}[${index}]`, ancestors));
      }
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidJson(path, 'custom object prototypes are not allowed');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      invalidJson(path, 'symbol properties are not allowed');
    }

    const result: { [key: string]: JsonValue } = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        invalidJson(`${path}.${key}`, 'accessors and non-enumerable values are not allowed');
      }
      Object.defineProperty(result, key, {
        value: normalizeJsonValue(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

export function normalizeMutationRequest(
  request: MutationGrantRequest
): NormalizedMutationGrantRequest {
  assertTlsMode(request.tlsMode);
  const operation = normalizeAxlOperation(request.operation);
  const data = normalizeJsonValue(request.data, 'data');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    invalidJson('data', 'the top-level AXL payload must be an object');
  }
  const normalizedData = data as { readonly [key: string]: JsonValue };

  let opts: ExecuteOperationOptions | undefined;
  if (request.opts !== undefined) {
    const normalizedOptions = normalizeJsonValue(request.opts, 'opts');
    if (
      normalizedOptions === null ||
      typeof normalizedOptions !== 'object' ||
      Array.isArray(normalizedOptions)
    ) {
      invalidJson('opts', 'execute options must be an object');
    }
    const allowedKeys = new Set(['clean', 'dataContainerIdentifierTails', 'removeAttributes']);
    for (const [key, value] of Object.entries(normalizedOptions)) {
      if (!allowedKeys.has(key)) invalidJson(`opts.${key}`, 'unknown execute option');
      if (
        key === 'dataContainerIdentifierTails'
          ? typeof value !== 'string'
          : typeof value !== 'boolean'
      ) {
        invalidJson(`opts.${key}`, 'invalid execute option type');
      }
    }
    opts = Object.freeze(normalizedOptions) as ExecuteOperationOptions;
  }

  const credentials = { ...request.credentials };
  const credentialScope = request.credentials[CREDENTIAL_SCOPE];
  if (credentialScope !== undefined) {
    Object.defineProperty(credentials, CREDENTIAL_SCOPE, {
      value: credentialScope,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(credentials);
  return Object.freeze({
    credentials,
    tlsMode: request.tlsMode,
    operation,
    data: normalizedData,
    ...(opts !== undefined && { opts }),
    autoPage: request.autoPage === true,
  });
}

function digestNormalizedMutationRequest(request: NormalizedMutationGrantRequest): string {
  const binding = {
    operation: request.operation,
    data: request.data,
    opts: request.opts ?? null,
    autoPage: request.autoPage === true,
    tlsMode: request.tlsMode,
  };
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

export function createMutationRequestDigest(request: MutationGrantRequest): string {
  return digestNormalizedMutationRequest(normalizeMutationRequest(request));
}

export async function createMutationGrant(
  options: CreateMutationGrantOptions,
  context: { now?: () => number; authority?: MutationGrantAuthority } = {}
): Promise<MutationGrant> {
  const now = context.now?.() ?? Date.now();
  const normalizedRequest = normalizeMutationRequest(options.request);
  if (typeof options.expiresAt !== 'string') {
    invalidGrant('expiresAt', 'must be a primitive string');
  }
  const expiresAt = Date.parse(options.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_EXPIRY_INVALID',
      'Mutation grant expiry must be a future timestamp'
    );
  }
  if (typeof options.packageVersion !== 'string' || !options.packageVersion.trim()) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_PACKAGE_INVALID',
      'Mutation grants require a package version'
    );
  }
  if (options.id !== undefined && typeof options.id !== 'string') {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_ID_INVALID',
      'Mutation grant id must be a primitive string'
    );
  }
  if (options.id !== undefined && !options.id.trim()) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_ID_INVALID',
      'Mutation grant id must not be empty'
    );
  }
  if (!isSupportedCucmVersion(normalizedRequest.credentials.version)) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_VERSION',
      `Unsupported CUCM version "${normalizedRequest.credentials.version}"`
    );
  }

  const artifacts = await loadAxlVersionArtifacts(normalizedRequest.credentials.version);
  const metadata = artifacts.operationMetadata[normalizedRequest.operation];
  if (!metadata) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_OPERATION',
      `Operation "${normalizedRequest.operation}" is not available for CUCM ${normalizedRequest.credentials.version}`
    );
  }
  if (isReadOnlySqlQueryOperation(normalizedRequest.operation)) {
    assertReadOnlySqlQuery(normalizedRequest.data);
  }
  const mutation =
    normalizedRequest.operation === 'executeSQLUpdate' ||
    isMutationOperation(normalizedRequest.operation, metadata);
  if (!mutation) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_NOT_REQUIRED',
      `Operation "${normalizedRequest.operation}" is read-only and does not accept a mutation grant`
    );
  }

  const unsignedGrant: UnsignedMutationGrant = {
    id: options.id ?? randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    target: (context.authority ?? defaultMutationGrantAuthority).targetFor(
      normalizedRequest.credentials
    ),
    operation: normalizedRequest.operation,
    requestDigest: digestNormalizedMutationRequest(normalizedRequest),
    schemaDigest: artifacts.operationSchemaDigest,
    packageVersion: options.packageVersion,
  };
  const grant: MutationGrant = {
    ...unsignedGrant,
    provenance: (context.authority ?? defaultMutationGrantAuthority).sign(unsignedGrant),
  };
  Object.freeze(grant.target);
  return Object.freeze(grant);
}

export function consumeMutationGrant(options: {
  grant: MutationGrant;
  request: MutationGrantRequest;
  packageVersion: string;
  schemaDigest: string;
  replayStore?: MutationGrantReplayStore;
  authority?: MutationGrantAuthority;
  now?: () => number;
}): NormalizedMutationGrantRequest {
  const grant = validateGrant(options.grant);
  const request = normalizeMutationRequest(options.request);
  const now = options.now?.() ?? Date.now();
  const expiresAt = Date.parse(grant.expiresAt);

  if (!(options.authority ?? defaultMutationGrantAuthority).verify(grant)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_PROVENANCE_INVALID',
      'Mutation grant provenance is invalid'
    );
  }

  const issuedAt = Date.parse(grant.issuedAt);
  if (
    !grant.id ||
    !Number.isFinite(issuedAt) ||
    issuedAt > now ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw new AxlPolicyError('AXL_MUTATION_GRANT_EXPIRED', 'Mutation grant has expired');
  }
  const expectedTarget = (options.authority ?? defaultMutationGrantAuthority).targetFor(
    request.credentials
  );
  if (
    grant.target.endpointDigest !== expectedTarget.endpointDigest ||
    grant.target.principalDigest !== expectedTarget.principalDigest ||
    grant.target.version !== expectedTarget.version
  ) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_TARGET_DRIFT',
      'Mutation target changed after preview'
    );
  }
  if (
    grant.operation !== request.operation ||
    grant.requestDigest !== digestNormalizedMutationRequest(request)
  ) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_REQUEST_DRIFT',
      'Mutation request changed after preview'
    );
  }
  if (grant.schemaDigest !== options.schemaDigest) {
    throw new AxlPolicyError('AXL_MUTATION_GRANT_SCHEMA_DRIFT', 'AXL schema changed after preview');
  }
  if (grant.packageVersion !== options.packageVersion) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_PACKAGE_DRIFT',
      'Package version changed after preview'
    );
  }

  const replayStore = options.replayStore ?? defaultMutationGrantReplayStore;
  if (!replayStore.consume(grant.id, expiresAt, now)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_REPLAYED',
      'Mutation grant has already been consumed'
    );
  }
  return request;
}
