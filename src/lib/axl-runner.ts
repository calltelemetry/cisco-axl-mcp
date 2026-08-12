import type { CucmCredentials } from '../types/credentials';
import { AxlPolicyError } from '../types/axl/errors';
import type { AxlAPIService } from '../services/axl/index';
import { AxlAPIService as DefaultAxlAPIService } from '../services/axl/index';
import { assertTlsMode, type ExecuteOperationOptions, type TlsMode } from './axl-client';
import { redactCredentials, sanitizeError } from './audit-log';
import { isSupportedCucmVersion } from './version-manager';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import {
  consumeMutationGrant,
  defaultMutationGrantReplayStore,
  isMutationOperation,
  type MutationGrant,
  type MutationGrantAuthority,
  type MutationGrantReplayStore,
} from './mutation-grants';

export type AxlCallerSource = 'mcp' | 'cli' | 'workflow' | 'a2a';
export type AxlValidationMode = 'compatible' | 'strict';

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
}

export interface RunAxlDependencies {
  service?: AxlAPIService;
  packageVersion?: string;
  replayStore?: MutationGrantReplayStore;
  grantAuthority?: MutationGrantAuthority;
  now?: () => number;
}

export const AXL_RUNNER_PACKAGE_VERSION = '0.5.0';

export async function runAxl(
  options: RunAxlOptions,
  dependencies: RunAxlDependencies = {}
): Promise<unknown> {
  const { request, source, validationMode, mutationGrant } = options;
  const service = dependencies.service ?? new DefaultAxlAPIService();
  const packageVersion = dependencies.packageVersion ?? AXL_RUNNER_PACKAGE_VERSION;

  if (!['mcp', 'cli', 'workflow', 'a2a'].includes(source)) {
    throw new AxlPolicyError(
      'AXL_POLICY_SOURCE_INVALID',
      `Invalid AXL caller source "${String(source)}"`
    );
  }
  if (validationMode !== 'compatible' && validationMode !== 'strict') {
    throw new AxlPolicyError(
      'AXL_POLICY_VALIDATION_MODE',
      `Invalid AXL validation mode "${String(validationMode)}"`
    );
  }
  assertTlsMode(request.tlsMode);
  let dispatchRequest = request;

  if (validationMode === 'compatible' && source !== 'mcp') {
    throw new AxlPolicyError(
      'AXL_POLICY_VALIDATION_MODE',
      `Caller source "${source}" must use strict AXL validation`
    );
  }

  if (validationMode === 'strict') {
    if (!isSupportedCucmVersion(request.credentials.version)) {
      throw new AxlPolicyError(
        'AXL_UNSUPPORTED_VERSION',
        `Unsupported CUCM version "${request.credentials.version}"`
      );
    }

    const artifacts = await loadAxlVersionArtifacts(request.credentials.version);
    const metadata = artifacts.operationMetadata[request.operation];
    if (!metadata) {
      throw new AxlPolicyError(
        'AXL_UNSUPPORTED_OPERATION',
        `Operation "${request.operation}" is not available for CUCM ${request.credentials.version}`
      );
    }

    if (isMutationOperation(request.operation, metadata)) {
      if (!mutationGrant) {
        throw new AxlPolicyError(
          'AXL_MUTATION_GRANT_REQUIRED',
          `Operation "${request.operation}" requires a mutation grant`
        );
      }
      dispatchRequest = consumeMutationGrant({
        grant: mutationGrant,
        request,
        packageVersion,
        schemaDigest: artifacts.operationSchemaDigest,
        replayStore: dependencies.replayStore ?? defaultMutationGrantReplayStore,
        authority: dependencies.grantAuthority,
        now: dependencies.now,
      });
    } else if (mutationGrant) {
      throw new AxlPolicyError(
        'AXL_MUTATION_GRANT_NOT_REQUIRED',
        `Operation "${request.operation}" is read-only and does not accept a mutation grant`
      );
    }
  }

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
        dispatchRequest.tlsMode
      );
      return redactCredentials(result, [
        request.credentials.password,
        request.credentials.username,
      ]);
    }

    const result = await service.executeOperation(
      dispatchRequest.credentials,
      dispatchRequest.operation,
      dispatchRequest.data,
      dispatchRequest.opts,
      dispatchRequest.tlsMode
    );
    return redactCredentials(result, [request.credentials.password, request.credentials.username]);
  } catch (error) {
    throw sanitizeError(error, [request.credentials.password, request.credentials.username]);
  }
}
