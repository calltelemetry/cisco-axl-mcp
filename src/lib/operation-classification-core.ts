import type { OperationMetadata } from '../types/generated/axl-generated-types';
import { AXL_READ_ONLY_OPERATIONS_BY_VERSION } from '../types/generated/axl-operation-classification';

const READ_ONLY_OTHER_OPERATIONS = new Set(['executeSQLQuery', 'executeSQLQueryInactive']);

export function isMutationOperation(operation: string, metadata: OperationMetadata): boolean {
  if (READ_ONLY_OTHER_OPERATIONS.has(operation)) return false;
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
  const readOnlyOperations = (
    AXL_READ_ONLY_OPERATIONS_BY_VERSION as Record<string, readonly string[] | undefined>
  )[version];
  return readOnlyOperations?.includes(operation) !== true;
}
