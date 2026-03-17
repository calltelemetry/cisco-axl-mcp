import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AxlAPIService } from '../services/axl/index';
import type { ToolDefinition } from './types';
import { jsonResponse } from './types';
import { resolveCredentials } from '../lib/credential-resolver';
import { getEnabledTopLevelObjects, isSqlEnabled } from '../lib/tool-config';
import { toMcpError } from '../types/axl/errors';
import { assertRecord, extractCredentialOverrides, optionalObject, requireString } from '../types/axl/guards';
import {
  AXL_ACTION_OPERATIONS,
  AXL_OBJECT_OPERATIONS,
  AXL_OBJECTS_SOURCE_WSDL_VERSION,
  AXL_TOP_LEVEL_OBJECTS,
  type AxlTopLevelObject,
} from '../types/generated/axl-objects';
import {
  AXL_OPERATION_SCHEMAS,
  AXL_SCHEMAS_SOURCE_VERSION,
} from '../types/generated/axl-operation-schemas';
import type { ExecuteOperationOptions } from '../lib/axl-client';

const OPERATION_TO_OBJECT = (() => {
  const map = new Map<string, AxlTopLevelObject>();
  for (const [objectName, verbs] of Object.entries(AXL_OBJECT_OPERATIONS) as Array<
    [AxlTopLevelObject, Record<string, string>]
  >) {
    for (const operation of Object.values(verbs)) map.set(operation, objectName);
  }
  return map;
})();

/** Set of global action operation names that have no specific top-level object (e.g. doDeviceReset, doLdapSync). */
const GLOBAL_ACTION_OPERATIONS = new Set<string>(
  Object.entries(AXL_ACTION_OPERATIONS)
    .filter(([, info]) => info.object === null)
    .map(([op]) => op)
);

/** Convert ["name", "lines.line.dirn.pattern"] to { name: true, lines: { line: { dirn: { pattern: true } } } } */
export function buildReturnedTags(fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split('.');
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i]!;
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
    description: 'Execute any AXL operation by name (raw access via cisco-axl executeOperation). Supports CRUD operations (add/get/list/update/remove) as well as action operations (apply/reset/restart/do/lock/wipe). Use axl_describe_operation to explore the input schema for any operation.',
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
        cucm_host: { type: 'string' },
        cucm_username: { type: 'string' },
        cucm_password: { type: 'string' },
        cucm_version: { type: 'string' },
        operation: { type: 'string', description: 'AXL operation name (e.g. addPhone, getUser, listLineGroup)' },
        data: {
          type: 'object',
          description: 'AXL operation payload — the JSON body for the SOAP request (e.g. { "name": "SEPAAAABBBBCCCC" } for getPhone).',
        },
        returnedTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of field names to return. Use dot notation for nested fields (e.g. ["name", "model", "lines.line.dirn.pattern"]). Converted to AXL returnedTags format automatically.',
        },
        opts: {
          type: 'object',
          description: 'Optional executeOperation options (clean/removeAttributes/etc).',
        },
        autoPage: {
          type: 'boolean',
          description: 'Auto-paginate list operations. Fetches all pages and returns combined results. Max 10,000 rows. Only valid for list* operations.',
        },
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
      properties: {},
    },
  },
  {
    name: 'axl_list_operations',
    description: 'List all available operation names for a given top-level AXL object (CRUD verbs and action verbs such as apply/reset/restart where available)',
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
        objectName: { type: 'string', description: 'Top-level object name (e.g. Phone, User, LineGroup)' },
      },
      required: ['objectName'],
    },
  },
  {
    name: 'axl_describe_operation',
    description: 'Describe the input schema for an AXL operation — shows required fields, types, enums, and structure needed to build the data payload for axl_execute. Works for CRUD operations and action operations (apply/reset/restart/do/lock/wipe).',
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
        operationName: {
          type: 'string',
          description: 'AXL operation name (e.g. addPhone, getUser, listLine). Use axl_list_operations to discover valid names.',
        },
      },
      required: ['operationName'],
    },
  },
  {
    name: 'axl_list_action_operations',
    description: 'List all non-CRUD AXL action operations (apply/do/reset/restart/lock/wipe/assign/unassign). Optionally filter by object name or verb prefix. Use axl_describe_operation to get the input schema for any listed operation.',
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
        objectName: {
          type: 'string',
          description: 'Filter to actions for a specific top-level object (e.g. Phone, Line). Omit to list all action operations.',
        },
        verb: {
          type: 'string',
          description: 'Filter by verb prefix: apply, do, reset, restart, lock, wipe, assign, unassign. Omit to list all verbs.',
        },
      },
    },
  },
  {
    name: 'axl_sql_query',
    description: 'Execute a read-only SQL query against the CUCM Informix database via AXL executeSQLQuery',
    annotations: {
      title: 'AXL SQL Query',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        cucm_host: { type: 'string' },
        cucm_username: { type: 'string' },
        cucm_password: { type: 'string' },
        cucm_version: { type: 'string' },
        sql: { type: 'string', description: 'SQL SELECT query to execute against the CUCM Informix database' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'axl_sql_update',
    description: 'Execute a SQL INSERT, UPDATE, or DELETE against the CUCM Informix database via AXL executeSQLUpdate',
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
        cucm_host: { type: 'string' },
        cucm_username: { type: 'string' },
        cucm_password: { type: 'string' },
        cucm_version: { type: 'string' },
        sql: { type: 'string', description: 'SQL INSERT, UPDATE, or DELETE statement to execute against the CUCM Informix database' },
      },
      required: ['sql'],
    },
  },
];

export function getTools(): ToolDefinition[] {
  return tools;
}

export async function handleTool(name: string, args: unknown, axlAPI: AxlAPIService) {
  try {
    switch (name) {
      case 'axl_list_objects': {
        const enabled = getEnabledTopLevelObjects();
        const objects = enabled ? (AXL_TOP_LEVEL_OBJECTS.filter(o => enabled.has(o)) as AxlTopLevelObject[]) : AXL_TOP_LEVEL_OBJECTS;
        return jsonResponse({
          wsdlVersion: AXL_OBJECTS_SOURCE_WSDL_VERSION,
          objectCount: objects.length,
          objects,
        });
      }
      case 'axl_list_operations': {
        const obj = assertRecord(args);
        const objectName = requireString(obj, 'objectName') as AxlTopLevelObject;
        const enabled = getEnabledTopLevelObjects();
        if (enabled && !enabled.has(objectName)) {
          throw new McpError(ErrorCode.InvalidParams, `Object "${objectName}" is not enabled`);
        }
        const ops = (AXL_OBJECT_OPERATIONS as Record<string, unknown>)[objectName];
        if (!ops) throw new McpError(ErrorCode.InvalidParams, `Unknown objectName "${objectName}"`);
        return jsonResponse({
          wsdlVersion: AXL_OBJECTS_SOURCE_WSDL_VERSION,
          objectName,
          operations: ops,
        });
      }
      case 'axl_describe_operation': {
        const obj = assertRecord(args);
        const operationName = requireString(obj, 'operationName');
        const schema = AXL_OPERATION_SCHEMAS[operationName];
        if (!schema) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No schema for "${operationName}". Use axl_list_operations to find valid operations.`
          );
        }
        const enabled = getEnabledTopLevelObjects();
        if (enabled) {
          const objectName = OPERATION_TO_OBJECT.get(operationName);
          if (objectName && !enabled.has(objectName)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Operation "${operationName}" targets "${objectName}" which is not enabled`
            );
          }
        }
        return jsonResponse({ wsdlVersion: AXL_SCHEMAS_SOURCE_VERSION, operationName, ...schema });
      }
      case 'axl_execute': {
        const obj = assertRecord(args);
        const credentials = resolveCredentials(extractCredentialOverrides(obj));
        const operation = requireString(obj, 'operation');
        const data = optionalObject(obj, 'data') ?? {};
        const returnedTagsArray = Array.isArray(obj.returnedTags) ? obj.returnedTags.filter((t): t is string => typeof t === 'string') : undefined;
        const tags = returnedTagsArray && returnedTagsArray.length > 0
          ? { ...data, returnedTags: buildReturnedTags(returnedTagsArray) }
          : data;
        const rawOpts = optionalObject(obj, 'opts');
        const opts: ExecuteOperationOptions | undefined = rawOpts
          ? {
              clean: typeof rawOpts.clean === 'boolean' ? rawOpts.clean : undefined,
              removeAttributes:
                typeof rawOpts.removeAttributes === 'boolean' ? rawOpts.removeAttributes : undefined,
              dataContainerIdentifierTails:
                typeof rawOpts.dataContainerIdentifierTails === 'string'
                  ? rawOpts.dataContainerIdentifierTails
                  : undefined,
            }
          : undefined;

        const enabled = getEnabledTopLevelObjects();
        if (enabled) {
          const objectName = OPERATION_TO_OBJECT.get(operation);
          if (!objectName) {
            // Allow global action operations (e.g. doDeviceReset, doLdapSync) which have no specific object
            if (!GLOBAL_ACTION_OPERATIONS.has(operation)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Operation "${operation}" is not mapped to a top-level object; with enabled_objects set, only mapped CRUD/action operations and global action operations are allowed`
              );
            }
          } else if (!enabled.has(objectName)) {
            throw new McpError(ErrorCode.InvalidParams, `Operation "${operation}" targets "${objectName}" which is not enabled`);
          }
        }

        // Auto-pagination for list operations
        if (obj.autoPage === true) {
          if (!operation.startsWith('list')) {
            throw new McpError(ErrorCode.InvalidParams, `autoPage is only valid for list operations, got "${operation}"`);
          }
          return jsonResponse(await axlAPI.listAll(credentials, operation, tags as Record<string, unknown>, opts));
        }

        return jsonResponse(await axlAPI.executeOperation(credentials, operation, tags, opts));
      }
      case 'axl_list_action_operations': {
        const obj = assertRecord(args);
        const objectFilter = typeof obj.objectName === 'string' ? obj.objectName : undefined;
        const verbFilter = typeof obj.verb === 'string' ? obj.verb : undefined;
        const entries = Object.entries(AXL_ACTION_OPERATIONS).filter(([, info]) => {
          if (objectFilter && info.object !== objectFilter) return false;
          if (verbFilter && info.verb !== verbFilter) return false;
          return true;
        });
        const operations = Object.fromEntries(entries);
        return jsonResponse({
          wsdlVersion: AXL_OBJECTS_SOURCE_WSDL_VERSION,
          count: entries.length,
          operations,
        });
      }
      case 'axl_sql_query': {
        if (!isSqlEnabled()) {
          throw new McpError(ErrorCode.InvalidParams, 'SQL operations are disabled (AXL_MCP_ENABLE_SQL=false)');
        }
        const obj = assertRecord(args);
        const credentials = resolveCredentials(extractCredentialOverrides(obj));
        const sql = requireString(obj, 'sql');
        return jsonResponse(await axlAPI.executeOperation(credentials, 'executeSQLQuery', { sql }));
      }
      case 'axl_sql_update': {
        if (!isSqlEnabled()) {
          throw new McpError(ErrorCode.InvalidParams, 'SQL operations are disabled (AXL_MCP_ENABLE_SQL=false)');
        }
        const obj = assertRecord(args);
        const credentials = resolveCredentials(extractCredentialOverrides(obj));
        const sql = requireString(obj, 'sql');
        return jsonResponse(await axlAPI.executeOperation(credentials, 'executeSQLUpdate', { sql }));
      }
      default:
        return null;
    }
  } catch (error) {
    throw toMcpError(error);
  }
}
