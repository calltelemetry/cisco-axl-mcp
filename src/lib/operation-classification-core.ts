import type { OperationMetadata } from '../types/generated/axl-generated-types';
import {
  AXL_MUTATION_OBJECTS_BY_VERSION,
  AXL_READ_ONLY_OPERATIONS_BY_VERSION,
} from '../types/generated/axl-operation-classification';
import { SUPPORTED_CUCM_VERSIONS } from './version-manager';

const AMBIGUOUS_SQL_QUERY_OPERATIONS = new Set(['executeSQLQuery', 'executeSQLQueryInactive']);

export function isMutationOperation(operation: string, metadata: OperationMetadata): boolean {
  if (metadata.kind === 'crud' && (metadata.verb === 'get' || metadata.verb === 'list')) {
    return false;
  }
  return true;
}

export function isMutationOperationFromCatalog(
  operation: string,
  catalog: Record<string, OperationMetadata>
): boolean {
  const metadata = catalog[operation];
  return metadata ? isMutationOperation(operation, metadata) : true;
}

export function isMutationOperationForVersion(operation: string, version: string): boolean {
  // CUCM accepts SQL views, virtual tables, sequence operators, and routines
  // whose side effects cannot be proven absent without an immutable catalog.
  // Preserve the lexical SELECT screen separately, but never grant SQL reads
  // automatic retry semantics.
  if (AMBIGUOUS_SQL_QUERY_OPERATIONS.has(operation)) return true;
  const readOnlyOperations = (
    AXL_READ_ONLY_OPERATIONS_BY_VERSION as Record<string, readonly string[] | undefined>
  )[version];
  return readOnlyOperations?.includes(operation) !== true;
}

/**
 * Compact catalog-backed admission check for tool advertisement. It avoids
 * importing the per-version schema payloads just to decide whether preview can
 * ever mint a grant for an enabled object.
 */
export function hasAuthorizedObjectMutation(enabledObjects: ReadonlySet<string>): boolean {
  return SUPPORTED_CUCM_VERSIONS.some(version => {
    const mutationObjects = AXL_MUTATION_OBJECTS_BY_VERSION[version];
    return mutationObjects.some(objectName => enabledObjects.has(objectName));
  });
}
