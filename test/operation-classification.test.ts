import { describe, expect, it } from 'vitest';
import { isMutationOperation, isMutationOperationFromCatalog } from '../src/lib/mutation-grants';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';

describe('catalog-aware AXL operation classification', () => {
  it.each(['12.5', '14.0', '15.0'] as const)(
    'classifies generated read and write families for CUCM %s',
    async version => {
      const artifacts = await loadAxlVersionArtifacts(version);

      for (const operation of [
        'getPhone',
        'listPhone',
        'executeSQLQuery',
        'executeSQLQueryInactive',
      ]) {
        expect(
          isMutationOperation(operation, artifacts.operationMetadata[operation]!),
          operation
        ).toBe(false);
        expect(isMutationOperationFromCatalog(operation, artifacts.operationMetadata)).toBe(false);
      }

      for (const operation of [
        'addPhone',
        'updatePhone',
        'removePhone',
        'executeSQLUpdate',
        'doDeviceReset',
      ]) {
        expect(
          isMutationOperation(operation, artifacts.operationMetadata[operation]!),
          operation
        ).toBe(true);
        expect(isMutationOperationFromCatalog(operation, artifacts.operationMetadata)).toBe(true);
      }
    }
  );

  it('classifies operations missing from the supplied catalog conservatively as mutations', () => {
    expect(isMutationOperationFromCatalog('vendorUnknownOperation', {})).toBe(true);
    expect(isMutationOperationFromCatalog('getVendorUnknown', {})).toBe(true);
  });
});
