import { describe, expect, it } from 'vitest';
import {
  isMutationOperation,
  isMutationOperationForVersion,
  isMutationOperationFromCatalog,
} from '../src/lib/mutation-grants';
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

  it.each(['12.0', '15.0'] as const)(
    'matches strict catalog classification for every generated CUCM %s operation',
    async version => {
      const artifacts = await loadAxlVersionArtifacts(version);

      for (const [operation, metadata] of Object.entries(artifacts.operationMetadata)) {
        expect(isMutationOperationForVersion(operation, version), operation).toBe(
          isMutationOperation(operation, metadata)
        );
      }
    }
  );

  it('uses the selected version and remains conservative for unsupported operations', () => {
    expect(isMutationOperationForVersion('getAuthzKey', '12.0')).toBe(false);
    expect(isMutationOperationForVersion('listAuthzKeys', '12.0')).toBe(false);
    expect(isMutationOperationForVersion('getAuthzKey', '15.0')).toBe(true);
    expect(isMutationOperationForVersion('getVendorUnknown', '15.0')).toBe(true);
    expect(isMutationOperationForVersion('executeSQLQueryInactive', '12.0')).toBe(true);
    expect(isMutationOperationForVersion('executeSQLQueryInactive', '15.0')).toBe(false);
  });
});
