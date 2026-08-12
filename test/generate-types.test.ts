import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as wsdlSupport from '../src/types/generated/wsdl-support';
import * as axlObjects from '../src/types/generated/axl-objects';
import * as operationSchemas from '../src/types/generated/axl-operation-schemas';

const EXPECTED_VERSIONS = ['11.0', '11.5', '12.0', '12.5', '14.0', '15.0'];
const CATALOG_OPERATIONS = [
  'listCallManager',
  'getCallManager',
  'updateEnterprisePhoneConfig',
  'doDeviceReset',
];

type GeneratedModules = {
  OPERATIONS_BY_VERSION?: Record<string, readonly string[]>;
  AXL_SCHEMA_SOURCE_DIGESTS_BY_VERSION?: Record<string, unknown>;
  AXL_TOP_LEVEL_OBJECTS_BY_VERSION?: Record<string, readonly string[]>;
  AXL_OBJECT_OPERATIONS_BY_VERSION?: Record<string, Record<string, Record<string, string>>>;
  AXL_ACTION_OPERATIONS_BY_VERSION?: Record<string, Record<string, unknown>>;
  AXL_OPERATION_SCHEMAS_BY_VERSION?: Record<string, Record<string, any>>;
  AXL_OPERATION_METADATA_BY_VERSION?: Record<string, Record<string, unknown>>;
  AXL_OPERATION_SCHEMA_DIGESTS_BY_VERSION?: Record<string, string>;
};

const support = wsdlSupport as GeneratedModules;
const objects = axlObjects as GeneratedModules;
const schemas = operationSchemas as GeneratedModules;

function readGolden(version: '11.5' | '15.0'): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`fixtures/generator/${version}/schema-golden.json`, import.meta.url),
      'utf8'
    )
  );
}

function pickField(field: any): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      type: field.type,
      minOccurs: field.minOccurs,
      maxOccurs: field.maxOccurs,
      nillable: field.nillable,
      required: field.required,
      typeName: field.typeName,
      choice: field.choice,
    }).filter(([, value]) => value !== undefined)
  );
}

function actualGolden(version: '11.5' | '15.0'): unknown {
  const byOperation = schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version];
  const getCallManager = byOperation?.getCallManager;
  const addPhone = byOperation?.addPhone;
  const vendorConfig = byOperation?.updateEnterprisePhoneConfig?.fields.vendorConfig;
  const line = addPhone?.fields.phone.fields.lines.fields.line;

  return {
    sourceDigests: support.AXL_SCHEMA_SOURCE_DIGESTS_BY_VERSION?.[version],
    operationSchemaDigest: schemas.AXL_OPERATION_SCHEMA_DIGESTS_BY_VERSION?.[version],
    catalogOperations: CATALOG_OPERATIONS.filter(operation =>
      support.OPERATIONS_BY_VERSION?.[version]?.includes(operation)
    ),
    getCallManager: {
      verb: getCallManager?.verb,
      object: getCallManager?.object,
      choices: getCallManager?.choices,
      name: pickField(getCallManager?.fields.name ?? {}),
      uuid: pickField(getCallManager?.fields.uuid ?? {}),
    },
    repeatedPhoneLine: {
      ...pickField(line ?? {}),
      itemType: line?.items?.type,
      itemTypeName: line?.items?.typeName,
      itemIndex: pickField(line?.items?.fields?.index ?? {}),
      itemDirnPattern: pickField(line?.items?.fields?.dirn?.fields?.pattern ?? {}),
    },
    protocolEnum: addPhone?.fields.phone.fields.protocol.enum,
    vendorConfig: {
      ...pickField(vendorConfig ?? {}),
      opaque: vendorConfig?.opaque,
    },
  };
}

function collectBrokenChoiceLinks(
  shape: { fields?: Record<string, any>; choices?: Array<{ options: string[][] }> },
  path: string,
  broken: string[]
): void {
  const choices = shape.choices ?? [];
  for (const [name, field] of Object.entries(shape.fields ?? {})) {
    const memberships = Array.isArray(field.choice)
      ? field.choice
      : field.choice === undefined
        ? []
        : [field.choice];
    for (const choiceIndex of memberships) {
      const options = choices[choiceIndex]?.options.flat() ?? [];
      if (!options.includes(name)) broken.push(`${path}.${name} -> choice ${choiceIndex}`);
    }
    collectBrokenChoiceLinks(field.items ?? field, `${path}.${name}`, broken);
  }
}

describe('generated AXL version contract', () => {
  it('publishes deterministic operation and object catalogs for all supported versions', () => {
    expect(Object.keys(support.OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_TOP_LEVEL_OBJECTS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_OBJECT_OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_ACTION_OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);

    for (const version of EXPECTED_VERSIONS) {
      expect(support.OPERATIONS_BY_VERSION?.[version]).toEqual(
        [...(support.OPERATIONS_BY_VERSION?.[version] ?? [])].sort()
      );
      expect(support.OPERATIONS_BY_VERSION?.[version]).toEqual(
        expect.arrayContaining(CATALOG_OPERATIONS)
      );
      expect(Object.keys(schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version] ?? {}).sort()).toEqual(
        support.OPERATIONS_BY_VERSION?.[version]
      );
      expect(
        Object.keys(schemas.AXL_OPERATION_METADATA_BY_VERSION?.[version] ?? {}).sort()
      ).toEqual(support.OPERATIONS_BY_VERSION?.[version]);
      expect(schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version]).toHaveProperty(
        'executeSQLQuery.kind',
        'other'
      );
      expect(objects.AXL_ACTION_OPERATIONS_BY_VERSION?.[version]).toHaveProperty('doDeviceReset');
    }
  });

  it.each(['11.5', '15.0'] as const)(
    'matches the %s schema golden for choices, arrays, nillability, enums, and opaque content',
    version => {
      expect(actualGolden(version)).toEqual(readGolden(version));
    }
  );

  it.each(['11.5', '15.0'] as const)(
    'keeps every %s nested choice membership linked to its declaring group',
    version => {
      const broken: string[] = [];
      for (const [operation, schema] of Object.entries(
        schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version] ?? {}
      )) {
        collectBrokenChoiceLinks(schema, operation, broken);
      }
      expect(broken).toEqual([]);
    }
  );

  it('keeps the latest-version aliases used by the MCP surface', () => {
    expect(operationSchemas.AXL_SCHEMAS_SOURCE_VERSION).toBe('15.0');
    expect(operationSchemas.AXL_OPERATION_SCHEMAS).toBe(
      schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.['15.0']
    );
    expect(axlObjects.AXL_TOP_LEVEL_OBJECTS).toBe(
      objects.AXL_TOP_LEVEL_OBJECTS_BY_VERSION?.['15.0']
    );
  });
});
