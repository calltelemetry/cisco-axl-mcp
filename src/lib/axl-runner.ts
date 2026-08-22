import type { CucmCredentials } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';
import type { AxlAPIService } from '../services/axl/index';
import {
  AxlAPIService as DefaultAxlAPIService,
  STRICT_AXL_EXECUTION_POLICY,
} from '../services/axl/index';
import { assertTlsMode, type ExecuteOperationOptions, type TlsMode } from './axl-client';
import { redactCredentials, sanitizeError } from './audit-log';
import { isSupportedCucmVersion } from './version-manager';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import {
  consumeMutationGrant,
  createMutationGrant,
  defaultMutationGrantReplayStore,
  isMutationOperation,
  normalizeAxlOperation,
  normalizeMutationRequest,
  assertReadOnlySqlQuery,
  isReadOnlySqlQueryOperation,
  type MutationGrant,
  type MutationGrantAuthority,
  type MutationGrantReplayStore,
} from './mutation-grants';
import { PACKAGE_VERSION } from './package-version';
import { validateOperationInput } from '../cli/schema-validation';

export type AxlCallerSource = 'mcp' | 'cli' | 'workflow' | 'a2a';
export type AxlValidationMode = 'strict';

export interface AxlRunRequest {
  credentials: CucmCredentials;
  tlsMode: TlsMode;
  operation: string;
  data: unknown;
  opts?: ExecuteOperationOptions;
  autoPage?: boolean;
}

export interface RunAxlOptions {
  request: AxlRunRequest;
  source: AxlCallerSource;
  validationMode: AxlValidationMode;
  mutationGrant?: MutationGrant;
  signal?: AbortSignal;
}

export interface RunAxlDependencies {
  service?: AxlAPIService;
  packageVersion?: string;
  replayStore?: MutationGrantReplayStore;
  grantAuthority?: MutationGrantAuthority;
  now?: () => number;
}

export interface PreviewAxlMutationOptions {
  request: AxlRunRequest;
  source: AxlCallerSource;
  validationMode: AxlValidationMode;
  signal?: AbortSignal;
}

export interface AxlRunner {
  runAxl(options: RunAxlOptions): Promise<unknown>;
  previewMutation?(options: PreviewAxlMutationOptions): Promise<MutationGrant>;
}

export function createAxlRunner(dependencies: RunAxlDependencies = {}): AxlRunner {
  return Object.freeze({
    runAxl: (options: RunAxlOptions) => runAxl(options, dependencies),
    previewMutation: (options: PreviewAxlMutationOptions) =>
      previewAxlMutation(options, dependencies),
  });
}

export const AXL_RUNNER_PACKAGE_VERSION = PACKAGE_VERSION;

interface PreparedAxlRequest {
  request: AxlRunRequest;
  artifacts: Awaited<ReturnType<typeof loadAxlVersionArtifacts>>;
  mutation: boolean;
}

async function prepareAxlRequest(
  options: Pick<RunAxlOptions, 'request' | 'source' | 'validationMode'>
): Promise<PreparedAxlRequest> {
  const { request, source, validationMode } = options;
  if (!['mcp', 'cli', 'workflow', 'a2a'].includes(source)) {
    throw new AxlPolicyError(
      'AXL_POLICY_SOURCE_INVALID',
      `Invalid AXL caller source "${String(source)}"`
    );
  }
  if (validationMode !== 'strict') {
    throw new AxlPolicyError(
      'AXL_POLICY_VALIDATION_MODE',
      `Invalid AXL validation mode "${String(validationMode)}"`
    );
  }
  assertTlsMode(request.tlsMode);
  const operation = normalizeAxlOperation(request.operation);
  let strictRequest = normalizeMutationRequest({ ...request, operation });
  if (!isSupportedCucmVersion(strictRequest.credentials.version)) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_VERSION',
      `Unsupported CUCM version "${strictRequest.credentials.version}"`
    );
  }

  const artifacts = await loadAxlVersionArtifacts(strictRequest.credentials.version);
  const metadata = artifacts.operationMetadata[strictRequest.operation];
  const schema = artifacts.operationSchemas[strictRequest.operation];
  if (!metadata || !schema) {
    throw new AxlPolicyError(
      'AXL_UNSUPPORTED_OPERATION',
      `Operation "${strictRequest.operation}" is not available for CUCM ${strictRequest.credentials.version}`
    );
  }
  try {
    strictRequest = normalizeMutationRequest({
      ...strictRequest,
      data: validateOperationInput(schema, artifacts.enums, strictRequest.data),
    });
  } catch {
    throw new AxlPolicyError(
      'AXL_OPERATION_INPUT_INVALID',
      'Operation input is invalid for the selected CUCM version'
    );
  }
  if (isReadOnlySqlQueryOperation(strictRequest.operation)) {
    assertReadOnlySqlQuery(strictRequest.data);
  }
  return {
    request: strictRequest,
    artifacts,
    mutation:
      strictRequest.operation === 'executeSQLUpdate' ||
      isMutationOperation(strictRequest.operation, metadata),
  };
}

export async function previewAxlMutation(
  options: PreviewAxlMutationOptions,
  dependencies: RunAxlDependencies = {}
): Promise<MutationGrant> {
  if (options.signal?.aborted) {
    throw new AxlPolicyError('AXL_REQUEST_CANCELLED', 'Mutation preview was cancelled');
  }
  const prepared = await prepareAxlRequest(options);
  if (options.signal?.aborted) {
    throw new AxlPolicyError('AXL_REQUEST_CANCELLED', 'Mutation preview was cancelled');
  }
  if (!prepared.mutation) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_NOT_REQUIRED',
      `Operation "${prepared.request.operation}" is read-only and cannot be previewed for mutation approval`
    );
  }
  const now = dependencies.now?.() ?? Date.now();
  return createMutationGrant(
    {
      request: prepared.request,
      packageVersion: dependencies.packageVersion ?? AXL_RUNNER_PACKAGE_VERSION,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    },
    { now: dependencies.now, authority: dependencies.grantAuthority }
  );
}

export async function runAxl(
  options: RunAxlOptions,
  dependencies: RunAxlDependencies = {}
): Promise<unknown> {
  const { request, mutationGrant } = options;
  const service = dependencies.service ?? new DefaultAxlAPIService();
  const packageVersion = dependencies.packageVersion ?? AXL_RUNNER_PACKAGE_VERSION;

  const prepared = await prepareAxlRequest(options);
  const strictRequest = prepared.request;
  const artifacts = prepared.artifacts;
  let dispatchRequest: AxlRunRequest = strictRequest;
  const mutation = prepared.mutation;
  if (mutation) {
    if (!mutationGrant) {
      throw new AxlPolicyError(
        'AXL_MUTATION_GRANT_REQUIRED',
        `Operation "${strictRequest.operation}" requires a mutation grant`
      );
    }
    dispatchRequest = consumeMutationGrant({
      grant: mutationGrant,
      request: strictRequest,
      packageVersion,
      schemaDigest: artifacts.operationSchemaDigest,
      replayStore: dependencies.replayStore ?? defaultMutationGrantReplayStore,
      authority: dependencies.grantAuthority,
      now: dependencies.now,
    });
  } else if (mutationGrant) {
    throw new AxlPolicyError(
      'AXL_MUTATION_GRANT_NOT_REQUIRED',
      `Operation "${strictRequest.operation}" is read-only and does not accept a mutation grant`
    );
  }

  const sensitiveValues = [
    request.credentials.password,
    request.credentials.username,
    request.credentials.host,
  ];
  const executionPolicyArgs = [
    options.signal
      ? { ...STRICT_AXL_EXECUTION_POLICY, shutdownSignal: options.signal }
      : STRICT_AXL_EXECUTION_POLICY,
  ] as const;
  const redactResponse = (result: unknown): unknown =>
    redactCredentials(result, sensitiveValues, {
      kind: 'axl-response',
      operation: dispatchRequest.operation,
    });

  try {
    if (dispatchRequest.autoPage === true) {
      if (!dispatchRequest.operation.startsWith('list')) {
        throw new AxlPolicyError(
          'AXL_AUTOPAGE_INVALID',
          `Auto-pagination is only valid for list operations, got "${dispatchRequest.operation}"`
        );
      }
      if (
        !dispatchRequest.data ||
        typeof dispatchRequest.data !== 'object' ||
        Array.isArray(dispatchRequest.data)
      ) {
        throw new AxlPolicyError(
          'AXL_AUTOPAGE_INVALID',
          'Auto-pagination requires an object request payload'
        );
      }
      const result = await service.listAll(
        dispatchRequest.credentials,
        dispatchRequest.operation,
        dispatchRequest.data as Record<string, unknown>,
        dispatchRequest.opts,
        dispatchRequest.tlsMode,
        ...executionPolicyArgs
      );
      return redactResponse(result);
    }

    const result = await service.executeOperation(
      dispatchRequest.credentials,
      dispatchRequest.operation,
      dispatchRequest.data,
      dispatchRequest.opts,
      dispatchRequest.tlsMode,
      ...executionPolicyArgs
    );
    return redactResponse(result);
  } catch (error) {
    throw sanitizeError(error, sensitiveValues);
  }
}
