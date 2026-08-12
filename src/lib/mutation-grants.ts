import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AxlPolicyError } from '../types/axl/errors';
import { isSupportedCucmVersion } from './version-manager';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import type { OperationMetadata } from '../types/generated/axl-generated-types';
import { assertTlsMode, type ExecuteOperationOptions, type TlsMode } from './axl-client';
import type { CucmCredentials } from '../types/credentials';

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
  readonly target: { readonly host: string; readonly version: string };
  readonly operation: string;
  readonly requestDigest: string;
  readonly schemaDigest: string;
  readonly packageVersion: string;
  readonly provenance: string;
}

type UnsignedMutationGrant = Omit<MutationGrant, 'provenance'>;

function provenancePayload(grant: UnsignedMutationGrant): string {
  return JSON.stringify([
    grant.id,
    grant.issuedAt,
    grant.expiresAt,
    grant.target?.host,
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
    return createHmac('sha256', this.key).update(provenancePayload(grant)).digest('hex');
  }

  verify(grant: MutationGrant): boolean {
    if (typeof grant.provenance !== 'string' || !/^[a-f0-9]{64}$/.test(grant.provenance)) {
      return false;
    }
    const expected = Buffer.from(this.sign(grant), 'hex');
    const received = Buffer.from(grant.provenance, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
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
  private readonly consumedIds = new Set<string>();

  consume(id: string): boolean {
    if (this.consumedIds.has(id)) return false;
    this.consumedIds.add(id);
    return true;
  }
}

export const defaultMutationGrantReplayStore = new MutationGrantReplayStore();

function normalizedHost(host: string): string {
  return host.trim().toLowerCase();
}

type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface NormalizedMutationGrantRequest extends MutationGrantRequest {
  data: { readonly [key: string]: JsonValue };
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

  const credentials = Object.freeze({ ...request.credentials });
  return Object.freeze({
    credentials,
    tlsMode: request.tlsMode,
    operation: request.operation,
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

export function isMutationOperation(operation: string, metadata: OperationMetadata): boolean {
  if (operation === 'executeSQLQuery') return false;
  if (metadata.kind === 'crud' && (metadata.verb === 'get' || metadata.verb === 'list'))
    return false;
  return true;
}

export async function createMutationGrant(
  options: CreateMutationGrantOptions,
  context: { now?: () => number; authority?: MutationGrantAuthority } = {}
): Promise<MutationGrant> {
  const now = context.now?.() ?? Date.now();
  const normalizedRequest = normalizeMutationRequest(options.request);
  const expiresAt = Date.parse(options.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_EXPIRY_INVALID',
      'Mutation grant expiry must be a future timestamp'
    );
  }
  if (!options.packageVersion.trim()) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_PACKAGE_INVALID',
      'Mutation grants require a package version'
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
  if (!isMutationOperation(normalizedRequest.operation, metadata)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_NOT_REQUIRED',
      `Operation "${normalizedRequest.operation}" is read-only and does not accept a mutation grant`
    );
  }

  const unsignedGrant: UnsignedMutationGrant = {
    id: options.id ?? randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    target: {
      host: normalizedHost(normalizedRequest.credentials.host),
      version: normalizedRequest.credentials.version,
    },
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
  const { grant } = options;
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
  if (
    grant.target.host !== normalizedHost(request.credentials.host) ||
    grant.target.version !== request.credentials.version
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
  if (!replayStore.consume(grant.id)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_REPLAYED',
      'Mutation grant has already been consumed'
    );
  }
  return request;
}
