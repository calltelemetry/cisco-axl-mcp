import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, AxlRunner } from './types';
import { jsonResponse } from './types';
import { resolveAdmittedCredentials, type AxlToolRuntime } from '../lib/credential-resolver';
import { loadMcpConfig, type ResolvedMcpConfig } from '../lib/tool-config';
import { toMcpError } from '../types/axl/errors';
import {
  assertRecord,
  assertInlineCredentialPolicy,
  extractCredentialOverrides,
  optionalObject,
  requireString,
} from '../types/axl/guards';
import { loadAxlVersionArtifacts } from '../types/generated/axl-version-loader';
import type { AxlVersionArtifacts } from '../types/generated/axl-generated-types';
import { isSupportedCucmVersion, type SupportedCucmVersion } from '../lib/version-manager';
import type { ExecuteOperationOptions } from '../lib/axl-client';
import type { MutationGrant } from '../lib/mutation-grants';
import { AxlPolicyError } from '../types/axl/errors';
import { hasAuthorizedObjectMutation } from '../lib/operation-classification-core';

interface DiscoveryArtifacts {
  artifacts: AxlVersionArtifacts;
}

const discoveryArtifactsCache = new Map<SupportedCucmVersion, Promise<DiscoveryArtifacts>>();

async function loadDiscoveryArtifacts(version: SupportedCucmVersion): Promise<DiscoveryArtifacts> {
  let pending = discoveryArtifactsCache.get(version);
  if (!pending) {
    pending = loadAxlVersionArtifacts(version).then(artifacts => {
      return {
        artifacts,
      };
    });
    discoveryArtifactsCache.set(version, pending);
  }
  return pending;
}

function resolveDiscoveryVersion(
  args: Record<string, unknown>,
  config: ResolvedMcpConfig,
  runtime?: AxlToolRuntime
): SupportedCucmVersion {
  const fixedVersion = config.fixedTarget?.version;
  const requested =
    fixedVersion !== undefined
      ? args.cucm_version === undefined
        ? fixedVersion
        : args.cucm_version
      : (args.cucm_version ?? runtime?.startupEnvironment.CUCM_VERSION ?? process.env.CUCM_VERSION);
  if (fixedVersion !== undefined && requested !== fixedVersion) {
    throw new AxlPolicyError(
      'AXL_TARGET_VERSION_DRIFT',
      `Provider mode is pinned to CUCM ${fixedVersion}`
    );
  }
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'Missing CUCM_VERSION or cucm_version');
  }
  if (!isSupportedCucmVersion(requested)) {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported cucm_version "${requested}"`);
  }
  return requested;
}

const DISCOVERY_VERSION_INPUT = {
  cucm_version: {
    type: 'string',
    description: 'CUCM AXL schema version to inspect. Defaults to configured CUCM_VERSION.',
  },
};

/** Convert ["name", "lines.line.dirn.pattern"] to { name: true, lines: { line: { dirn: { pattern: true } } } } */
export function buildReturnedTags(fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (key === undefined) continue;
      if (i === parts.length - 1) {
        current[key] = true;
      } else {
        if (typeof current[key] !== 'object' || current[key] === null) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }
    }
  }
  return result;
}

export const tools: ToolDefinition[] = [
  {
    name: 'axl_execute',
    description:
      'Execute any AXL operation by name (raw access via cisco-axl executeOperation). Supports CRUD operations (add/get/list/update/remove) as well as action operations (apply/reset/restart/do/lock/wipe). Use axl_describe_operation to explore the input schema for any operation.',
    annotations: {
      title: 'Execute AXL Operation',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cucm_version: { type: 'string' },
        operation: {
          type: 'string',
          description: 'AXL operation name (e.g. addPhone, getUser, listLineGroup)',
        },
        data: {
          type: 'object',
          description:
            'AXL operation payload — the JSON body for the SOAP request (e.g. { "name": "SEPAAAABBBBCCCC" } for getPhone).',
        },
        returnedTags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of field names to return. Use dot notation for nested fields (e.g. ["name", "model", "lines.line.dirn.pattern"]). Converted to AXL returnedTags format automatically.',
        },
        opts: {
          type: 'object',
          description: 'Optional executeOperation options (clean/removeAttributes/etc).',
        },
        autoPage: {
          type: 'boolean',
          description:
            'Auto-paginate list operations. Fetches all pages and returns combined results. Max 10,000 rows. Only valid for list* operations.',
        },
        mutationGrant: {
          type: 'object',
          description:
            'Single-use, request-bound mutation authorization returned by a prior approved preview.',
        },
      },
      required: ['operation', 'data'],
    },
  },
  {
    name: 'axl_preview_mutation',
    description:
      'Validate and preview one authorized AXL mutation without contacting CUCM. Returns a short-lived, single-use grant bound to this exact request. The MCP client must obtain and record explicit human approval before using that grant; this tool does not verify a human identity or approve the change itself.',
    annotations: {
      title: 'Preview AXL Mutation',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cucm_version: { type: 'string' },
        operation: { type: 'string', description: 'Authorized mutation operation name.' },
        data: { type: 'object', description: 'Exact JSON payload to authorize.' },
        returnedTags: { type: 'array', items: { type: 'string' } },
        opts: { type: 'object', description: 'Exact executeOperation options to authorize.' },
        autoPage: { type: 'boolean' },
      },
      required: ['operation', 'data'],
    },
  },
  {
    name: 'axl_list_objects',
    description: 'List top-level AXL objects discovered in the WSDL',
    annotations: {
      title: 'List AXL Objects',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: DISCOVERY_VERSION_INPUT,
    },
  },
  {
    name: 'axl_list_operations',
    description:
      'List all available operation names for a given top-level AXL object (CRUD verbs and action verbs such as apply/reset/restart where available)',
    annotations: {
      title: 'List AXL Operations',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ...DISCOVERY_VERSION_INPUT,
        objectName: {
          type: 'string',
          description: 'Top-level object name (e.g. Phone, User, LineGroup)',
        },
      },
      required: ['objectName'],
    },
  },
  {
    name: 'axl_describe_operation',
    description:
      'Describe the input schema for an AXL operation — shows required fields, types, enums, and structure needed to build the data payload for axl_execute. Works for CRUD operations and action operations (apply/reset/restart/do/lock/wipe).',
    annotations: {
      title: 'Describe AXL Operation Schema',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ...DISCOVERY_VERSION_INPUT,
        operationName: {
          type: 'string',
          description:
            'AXL operation name (e.g. addPhone, getUser, listLine). Use axl_list_operations to discover valid names.',
        },
      },
      required: ['operationName'],
    },
  },
  {
    name: 'axl_list_action_operations',
    description:
      'List all non-CRUD AXL action operations (apply/do/reset/restart/lock/wipe/assign/unassign). Optionally filter by object name or verb prefix. Use axl_describe_operation to get the input schema for any listed operation.',
    annotations: {
      title: 'List AXL Action Operations',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ...DISCOVERY_VERSION_INPUT,
        objectName: {
          type: 'string',
          description:
            'Filter to actions for a specific top-level object (e.g. Phone, Line). Omit to list all action operations.',
        },
        verb: {
          type: 'string',
          description:
            'Filter by verb prefix: apply, do, reset, restart, lock, wipe, assign, unassign. Omit to list all verbs.',
        },
      },
    },
  },
  {
    name: 'axl_sql_query',
    description:
      'Execute a conservatively screened SQL SELECT against CUCM Informix via AXL executeSQLQuery. A mutation grant is required because view and routine side effects cannot be proven absent.',
    annotations: {
      title: 'AXL SQL Query',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cucm_version: { type: 'string' },
        sql: {
          type: 'string',
          description: 'SQL SELECT query to execute against the CUCM Informix database',
        },
        mutationGrant: {
          type: 'object',
          description:
            'Required single-use, request-bound mutation authorization returned by axl_preview_mutation after explicit client-side human approval.',
        },
      },
      required: ['sql', 'mutationGrant'],
    },
  },
  {
    name: 'axl_sql_update',
    description:
      'Execute a SQL INSERT, UPDATE, or DELETE against the CUCM Informix database via AXL executeSQLUpdate',
    annotations: {
      title: 'AXL SQL Update',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cucm_version: { type: 'string' },
        sql: {
          type: 'string',
          description:
            'SQL INSERT, UPDATE, or DELETE statement to execute against the CUCM Informix database',
        },
        mutationGrant: {
          type: 'object',
          description: 'Single-use, request-bound mutation authorization required for SQL updates.',
        },
      },
      required: ['sql', 'mutationGrant'],
    },
  },
];

const SQL_TOOL_NAMES = new Set(['axl_sql_query', 'axl_sql_update']);
const EXECUTION_TOOL_NAMES = new Set([
  'axl_execute',
  'axl_preview_mutation',
  'axl_sql_query',
  'axl_sql_update',
]);
const MCP_TOOL_NAMES = new Set(tools.map(tool => tool.name));

const INLINE_CREDENTIAL_INPUTS = {
  cucm_host: { type: 'string', description: 'Compatibility-only CUCM hostname override' },
  cucm_username: { type: 'string', description: 'Compatibility-only CUCM username override' },
  cucm_password: { type: 'string', description: 'Compatibility-only CUCM password override' },
};

function withInlineCredentialInputs(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...INLINE_CREDENTIAL_INPUTS,
        ...tool.inputSchema.properties,
      },
    },
  };
}

export function getTools(config: ResolvedMcpConfig = loadMcpConfig()): ToolDefinition[] {
  const sqlVisibleTools = config.sqlEnabled
    ? tools
    : tools.filter(tool => !SQL_TOOL_NAMES.has(tool.name));
  const canPreviewMutation =
    config.sqlEnabled ||
    config.allowGlobalActions ||
    config.enabledObjects === null ||
    hasAuthorizedObjectMutation(config.enabledObjects);
  const visibleTools = canPreviewMutation
    ? sqlVisibleTools
    : sqlVisibleTools.filter(tool => tool.name !== 'axl_preview_mutation');
  return config.allowInlineCredentials
    ? visibleTools.map(tool =>
        EXECUTION_TOOL_NAMES.has(tool.name) ? withInlineCredentialInputs(tool) : tool
      )
    : visibleTools;
}

/**
 * The exact-version artifact is the single source of truth for whether an
 * operation belongs to an object, is a global action, or is available at all.
 * Callers use this before every discovery or execution response so no path can
 * disclose an operation it would later reject.
 */
export function authorizeOperation(
  operation: string,
  artifacts: AxlVersionArtifacts,
  config: ResolvedMcpConfig
): void {
  const metadata = artifacts.operationMetadata[operation];
  if (!metadata) {
    throw new AxlPolicyError(
      'AXL_OPERATION_UNAVAILABLE',
      `Operation "${operation}" is unavailable for CUCM ${artifacts.version}`
    );
  }

  if (metadata.object) {
    if (config.enabledObjects === null || config.enabledObjects.has(metadata.object)) return;
    throw new AxlPolicyError(
      'AXL_OBJECT_DENIED',
      `Operation "${operation}" targets "${metadata.object}" which is not enabled`
    );
  }

  if (metadata.kind === 'action') {
    if (config.allowGlobalActions) return;
    throw new AxlPolicyError(
      'AXL_GLOBAL_ACTION_DENIED',
      `Global action "${operation}" requires AXL_MCP_ALLOW_GLOBAL_ACTIONS=true`
    );
  }

  // Object-less operations are not a public generic-execution escape hatch.
  // SQL has dedicated tools and is authorized by its own explicit capability.
  throw new AxlPolicyError(
    'AXL_OPERATION_UNAVAILABLE',
    `Operation "${operation}" is unavailable through axl_execute`
  );
}

function isAuthorizedOperation(
  operation: string,
  artifacts: AxlVersionArtifacts,
  config: ResolvedMcpConfig
): boolean {
  try {
    authorizeOperation(operation, artifacts, config);
    return true;
  } catch (error) {
    if (error instanceof AxlPolicyError) return false;
    throw error;
  }
}

function requireAuthorizedObjectOperations(
  objectName: string,
  artifacts: AxlVersionArtifacts,
  config: ResolvedMcpConfig
): Record<string, string> {
  const ops = artifacts.objectOperations[objectName];
  if (!ops) {
    throw new AxlPolicyError(
      'AXL_OPERATION_UNAVAILABLE',
      `Unknown objectName "${objectName}" for CUCM ${artifacts.version}`
    );
  }
  if (config.enabledObjects !== null && !config.enabledObjects.has(objectName)) {
    throw new AxlPolicyError('AXL_OBJECT_DENIED', `Object "${objectName}" is not enabled`);
  }
  const operationNames = Object.values(ops);
  if (operationNames.length === 0) {
    throw new AxlPolicyError(
      'AXL_OPERATION_UNAVAILABLE',
      `Object "${objectName}" has no available operations for CUCM ${artifacts.version}`
    );
  }
  for (const operation of operationNames) authorizeOperation(operation, artifacts, config);
  return ops;
}

function mutationGrantFromArgs(args: Record<string, unknown>): MutationGrant | undefined {
  const grant = args.mutationGrant ?? args.mutation_grant;
  return grant === undefined ? undefined : (grant as MutationGrant);
}

export async function handleTool(
  name: string,
  args: unknown,
  runner: AxlRunner,
  config: ResolvedMcpConfig = loadMcpConfig(),
  signalOrRuntime?: AbortSignal | AxlToolRuntime,
  runtime?: AxlToolRuntime
) {
  const runtimeIsProvided = (value: unknown): value is AxlToolRuntime =>
    typeof value === 'object' &&
    value !== null &&
    'credentialSource' in value &&
    'startupEnvironment' in value &&
    'now' in value;
  const requestRuntime =
    runtime ?? (runtimeIsProvided(signalOrRuntime) ? signalOrRuntime : undefined);
  const requestSignal = runtimeIsProvided(signalOrRuntime) ? undefined : signalOrRuntime;
  try {
    if (MCP_TOOL_NAMES.has(name)) {
      assertInlineCredentialPolicy(
        assertRecord(args),
        config.allowInlineCredentials && EXECUTION_TOOL_NAMES.has(name)
      );
    }
    switch (name) {
      case 'axl_list_objects': {
        const obj = assertRecord(args);
        const version = resolveDiscoveryVersion(obj, config, requestRuntime);
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const enabled = config.enabledObjects;
        const objects = enabled
          ? artifacts.topLevelObjects.filter(objectName => enabled.has(objectName))
          : artifacts.topLevelObjects;
        return jsonResponse({
          wsdlVersion: version,
          objectCount: objects.length,
          objects,
        });
      }
      case 'axl_list_operations': {
        const obj = assertRecord(args);
        const version = resolveDiscoveryVersion(obj, config, requestRuntime);
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const objectName = requireString(obj, 'objectName');
        const ops = requireAuthorizedObjectOperations(objectName, artifacts, config);
        return jsonResponse({
          wsdlVersion: version,
          objectName,
          operations: ops,
        });
      }
      case 'axl_describe_operation': {
        const obj = assertRecord(args);
        const version = resolveDiscoveryVersion(obj, config, requestRuntime);
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const operationName = requireString(obj, 'operationName');
        const schema = artifacts.operationSchemas[operationName];
        if (!schema) {
          throw new AxlPolicyError(
            'AXL_OPERATION_UNAVAILABLE',
            `No schema for "${operationName}". Use axl_list_operations to find valid operations.`
          );
        }
        authorizeOperation(operationName, artifacts, config);
        return jsonResponse({ wsdlVersion: version, operationName, ...schema });
      }
      case 'axl_execute': {
        const obj = assertRecord(args);
        if (config.credentialProvider && !requestRuntime) {
          throw new AxlPolicyError(
            'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
            'Provider credentials are unavailable before MCP startup completes'
          );
        }
        const credentials = await resolveAdmittedCredentials(
          extractCredentialOverrides(obj, config.allowInlineCredentials),
          config,
          requestRuntime ?? {
            credentialSource: undefined as never,
            startupEnvironment: process.env,
            now: () => Date.now(),
          }
        );
        const version = credentials.version;
        if (!isSupportedCucmVersion(version)) {
          throw new McpError(ErrorCode.InvalidParams, `Unsupported cucm_version "${version}"`);
        }
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const operation = requireString(obj, 'operation');
        const data = optionalObject(obj, 'data') ?? {};
        const returnedTagsArray = Array.isArray(obj.returnedTags)
          ? obj.returnedTags.filter((t): t is string => typeof t === 'string')
          : undefined;
        const tags =
          returnedTagsArray && returnedTagsArray.length > 0
            ? { ...data, returnedTags: buildReturnedTags(returnedTagsArray) }
            : data;
        const rawOpts = optionalObject(obj, 'opts');
        const opts: ExecuteOperationOptions | undefined = rawOpts
          ? {
              clean: typeof rawOpts.clean === 'boolean' ? rawOpts.clean : undefined,
              removeAttributes:
                typeof rawOpts.removeAttributes === 'boolean'
                  ? rawOpts.removeAttributes
                  : undefined,
              dataContainerIdentifierTails:
                typeof rawOpts.dataContainerIdentifierTails === 'string'
                  ? rawOpts.dataContainerIdentifierTails
                  : undefined,
            }
          : undefined;
        const mutationGrant = mutationGrantFromArgs(obj);

        authorizeOperation(operation, artifacts, config);

        return jsonResponse(
          await runner.runAxl({
            request: {
              credentials,
              tlsMode: config.tlsMode,
              operation,
              data: tags,
              ...(opts !== undefined && { opts }),
              autoPage: obj.autoPage === true,
            },
            source: 'mcp',
            validationMode: 'strict',
            ...(mutationGrant !== undefined && { mutationGrant }),
            ...(requestSignal && { signal: requestSignal }),
          })
        );
      }
      case 'axl_preview_mutation': {
        const obj = assertRecord(args);
        if (config.credentialProvider && !requestRuntime) {
          throw new AxlPolicyError(
            'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
            'Provider credentials are unavailable before MCP startup completes'
          );
        }
        const credentials = await resolveAdmittedCredentials(
          extractCredentialOverrides(obj, config.allowInlineCredentials),
          config,
          requestRuntime ?? {
            credentialSource: undefined as never,
            startupEnvironment: process.env,
            now: () => Date.now(),
          }
        );
        const version = credentials.version;
        if (!isSupportedCucmVersion(version)) {
          throw new McpError(ErrorCode.InvalidParams, `Unsupported cucm_version "${version}"`);
        }
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const operation = requireString(obj, 'operation');
        const data = optionalObject(obj, 'data') ?? {};
        const returnedTagsArray = Array.isArray(obj.returnedTags)
          ? obj.returnedTags.filter((tag): tag is string => typeof tag === 'string')
          : undefined;
        const taggedData =
          returnedTagsArray && returnedTagsArray.length > 0
            ? { ...data, returnedTags: buildReturnedTags(returnedTagsArray) }
            : data;
        const rawOpts = optionalObject(obj, 'opts');
        const opts: ExecuteOperationOptions | undefined = rawOpts
          ? {
              clean: typeof rawOpts.clean === 'boolean' ? rawOpts.clean : undefined,
              removeAttributes:
                typeof rawOpts.removeAttributes === 'boolean'
                  ? rawOpts.removeAttributes
                  : undefined,
              dataContainerIdentifierTails:
                typeof rawOpts.dataContainerIdentifierTails === 'string'
                  ? rawOpts.dataContainerIdentifierTails
                  : undefined,
            }
          : undefined;
        if (operation === 'executeSQLQuery' || operation === 'executeSQLUpdate') {
          if (!config.sqlEnabled) {
            throw new AxlPolicyError(
              'AXL_SQL_DISABLED',
              'SQL operations are disabled (AXL_MCP_ENABLE_SQL=false)'
            );
          }
        } else {
          authorizeOperation(operation, artifacts, config);
        }
        if (!runner.previewMutation) {
          throw new AxlPolicyError(
            'AXL_MUTATION_PREVIEW_UNAVAILABLE',
            'Mutation preview is unavailable in this MCP server'
          );
        }
        const mutationGrant = await runner.previewMutation({
          request: {
            credentials,
            tlsMode: config.tlsMode,
            operation,
            data: taggedData,
            ...(opts !== undefined && { opts }),
            autoPage: obj.autoPage === true,
          },
          source: 'mcp',
          validationMode: 'strict',
          ...(requestSignal && { signal: requestSignal }),
        });
        return jsonResponse({
          mutationGrant,
          approvalRequired:
            'Obtain explicit human approval in the MCP client before submitting this exact mutation grant.',
        });
      }
      case 'axl_list_action_operations': {
        const obj = assertRecord(args);
        const version = resolveDiscoveryVersion(obj, config, requestRuntime);
        const { artifacts } = await loadDiscoveryArtifacts(version);
        const objectFilter = typeof obj.objectName === 'string' ? obj.objectName : undefined;
        const verbFilter = typeof obj.verb === 'string' ? obj.verb : undefined;
        const entries = Object.entries(artifacts.actionOperations).filter(([operation, info]) => {
          if (objectFilter && info.object !== objectFilter) return false;
          if (verbFilter && info.verb !== verbFilter) return false;
          return isAuthorizedOperation(operation, artifacts, config);
        });
        const operations = Object.fromEntries(entries);
        return jsonResponse({
          wsdlVersion: version,
          count: entries.length,
          operations,
        });
      }
      case 'axl_sql_query': {
        if (!config.sqlEnabled) {
          throw new AxlPolicyError(
            'AXL_SQL_DISABLED',
            'SQL operations are disabled (AXL_MCP_ENABLE_SQL=false)'
          );
        }
        const obj = assertRecord(args);
        if (config.credentialProvider && !requestRuntime) {
          throw new AxlPolicyError(
            'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
            'Provider credentials are unavailable before MCP startup completes'
          );
        }
        const credentials = await resolveAdmittedCredentials(
          extractCredentialOverrides(obj, config.allowInlineCredentials),
          config,
          requestRuntime ?? {
            credentialSource: undefined as never,
            startupEnvironment: process.env,
            now: () => Date.now(),
          }
        );
        const sql = requireString(obj, 'sql');
        const mutationGrant = mutationGrantFromArgs(obj);
        return jsonResponse(
          await runner.runAxl({
            request: {
              credentials,
              tlsMode: config.tlsMode,
              operation: 'executeSQLQuery',
              data: { sql },
              autoPage: false,
            },
            source: 'mcp',
            validationMode: 'strict',
            ...(mutationGrant !== undefined && { mutationGrant }),
            ...(requestSignal && { signal: requestSignal }),
          })
        );
      }
      case 'axl_sql_update': {
        if (!config.sqlEnabled) {
          throw new AxlPolicyError(
            'AXL_SQL_DISABLED',
            'SQL operations are disabled (AXL_MCP_ENABLE_SQL=false)'
          );
        }
        const obj = assertRecord(args);
        if (config.credentialProvider && !requestRuntime) {
          throw new AxlPolicyError(
            'AXL_CREDENTIAL_SOURCE_UNAVAILABLE',
            'Provider credentials are unavailable before MCP startup completes'
          );
        }
        const credentials = await resolveAdmittedCredentials(
          extractCredentialOverrides(obj, config.allowInlineCredentials),
          config,
          requestRuntime ?? {
            credentialSource: undefined as never,
            startupEnvironment: process.env,
            now: () => Date.now(),
          }
        );
        const sql = requireString(obj, 'sql');
        const mutationGrant = mutationGrantFromArgs(obj);
        return jsonResponse(
          await runner.runAxl({
            request: {
              credentials,
              tlsMode: config.tlsMode,
              operation: 'executeSQLUpdate',
              data: { sql },
              autoPage: false,
            },
            source: 'mcp',
            validationMode: 'strict',
            ...(mutationGrant !== undefined && { mutationGrant }),
            ...(requestSignal && { signal: requestSignal }),
          })
        );
      }
      default:
        return null;
    }
  } catch (error) {
    throw toMcpError(error);
  }
}
