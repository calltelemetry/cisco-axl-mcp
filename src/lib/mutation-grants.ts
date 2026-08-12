import { createHash, randomUUID } from 'node:crypto';
import { AxlPolicyError } from '../types/axl/errors';
import { isSupportedCucmVersion } from './version-manager';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import type { OperationMetadata } from '../types/generated/axl-generated-types';
import type { ExecuteOperationOptions, TlsMode } from './axl-client';
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
  id: string;
  issuedAt: string;
  expiresAt: string;
  target: { host: string; version: string };
  operation: string;
  requestDigest: string;
  schemaDigest: string;
  packageVersion: string;
}

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

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (seen.has(value)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_REQUEST_INVALID',
      'Mutation preview requests cannot contain cycles'
    );
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
    if (value instanceof Date) return value.toISOString();

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = canonicalize(item, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function createMutationRequestDigest(request: MutationGrantRequest): string {
  const binding = canonicalize({
    operation: request.operation,
    data: request.data,
    opts: request.opts ?? null,
    autoPage: request.autoPage === true,
    tlsMode: request.tlsMode,
  });
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

export function isMutationOperation(operation: string, metadata: OperationMetadata): boolean {
  if (operation === 'executeSQLQuery') return false;
  if (metadata.kind === 'crud' && (metadata.verb === 'get' || metadata.verb === 'list'))
    return false;
  return true;
}

export async function createMutationGrant(
  options: CreateMutationGrantOptions,
  clock: { now?: () => number } = {}
): Promise<MutationGrant> {
  const now = clock.now?.() ?? Date.now();
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
  if (!isSupportedCucmVersion(options.request.credentials.version)) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_VERSION',
      `Unsupported CUCM version "${options.request.credentials.version}"`
    );
  }

  const artifacts = await loadAxlVersionArtifacts(options.request.credentials.version);
  const metadata = artifacts.operationMetadata[options.request.operation];
  if (!metadata) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_OPERATION',
      `Operation "${options.request.operation}" is not available for CUCM ${options.request.credentials.version}`
    );
  }
  if (!isMutationOperation(options.request.operation, metadata)) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_NOT_REQUIRED',
      `Operation "${options.request.operation}" is read-only and does not accept a mutation grant`
    );
  }

  return {
    id: options.id ?? randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    target: {
      host: normalizedHost(options.request.credentials.host),
      version: options.request.credentials.version,
    },
    operation: options.request.operation,
    requestDigest: createMutationRequestDigest(options.request),
    schemaDigest: artifacts.operationSchemaDigest,
    packageVersion: options.packageVersion,
  };
}

export function consumeMutationGrant(options: {
  grant: MutationGrant;
  request: MutationGrantRequest;
  packageVersion: string;
  schemaDigest: string;
  replayStore?: MutationGrantReplayStore;
  now?: () => number;
}): void {
  const { grant, request } = options;
  const now = options.now?.() ?? Date.now();
  const expiresAt = Date.parse(grant.expiresAt);

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
    grant.requestDigest !== createMutationRequestDigest(request)
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
}
