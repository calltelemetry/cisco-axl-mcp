import type { OperationMetadata } from '../types/generated/axl-generated-types';

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
