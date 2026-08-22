import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as wsdlSupport from '../src/types/generated/wsdl-support';
import * as axlObjects from '../src/types/generated/axl-objects';
import * as operationSchemas from '../src/types/generated/axl-operation-schemas';
import * as operationClassification from '../src/types/generated/axl-operation-classification';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';

const EXPECTED_VERSIONS = ['11.0', '11.5', '12.0', '12.5', '14.0', '15.0'] as const;
type ExpectedVersion = (typeof EXPECTED_VERSIONS)[number];
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATED_FILES = [
  'generated/axl-top-level-objects.json',
  'src/types/generated/axl-generated-types.ts',
  'src/types/generated/axl-known-top-level-objects.ts',
  'src/types/generated/axl-latest.ts',
  'src/types/generated/axl-objects.ts',
  'src/types/generated/axl-operation-classification.ts',
  'src/types/generated/axl-operation-schemas.ts',
  'src/types/generated/axl-version-loader.ts',
  'src/types/generated/versions/axl-version-11-0.ts',
  'src/types/generated/versions/axl-version-11-5.ts',
  'src/types/generated/versions/axl-version-12-0.ts',
  'src/types/generated/versions/axl-version-12-5.ts',
  'src/types/generated/versions/axl-version-14-0.ts',
  'src/types/generated/versions/axl-version-15-0.ts',
  'src/types/generated/wsdl-support.ts',
];
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
  AXL_READ_ONLY_OPERATIONS_BY_VERSION?: Record<string, readonly string[]>;
};

const support = wsdlSupport as GeneratedModules;
const objects = axlObjects as GeneratedModules;
const schemas = operationSchemas as GeneratedModules;
const classification = operationClassification as GeneratedModules;
const execFileAsync = promisify(execFile);

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function listGeneratedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else files.push(relative(root, entryPath));
    }
  }
  await walk(join(root, 'src/types/generated'));
  await walk(join(root, 'generated'));
  return files.sort();
}

function readGolden(version: ExpectedVersion): unknown {
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
      sequence: field.sequence,
    }).filter(([, value]) => value !== undefined)
  );
}

function actualGolden(version: ExpectedVersion): unknown {
  const byOperation = schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version];
  const getCallManager = byOperation?.getCallManager;
  const addPhone = byOperation?.addPhone;
  const addSipProfile = byOperation?.addSipProfile;
  const addT1Gateway = byOperation?.addCiscoCatalyst6000T1VoIPGatewayT1;
  const vendorConfig = byOperation?.updateEnterprisePhoneConfig?.fields.vendorConfig;
  const line = addPhone?.fields.phone.fields.lines.fields.line;
  const sipProfile = addSipProfile?.fields.sipProfile;
  const sipProfileSequence = sipProfile?.sequences?.find((sequence: any) =>
    sequence.fields.includes('name')
  );

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
    optionalSipProfileSequence: {
      group: sipProfileSequence
        ? {
            minOccurs: sipProfileSequence.minOccurs,
            maxOccurs: sipProfileSequence.maxOccurs,
            containsName: sipProfileSequence.fields.includes('name'),
          }
        : undefined,
      name: pickField(sipProfile?.fields.name ?? {}),
    },
    protocolEnum: addPhone?.fields.phone.fields.protocol.enum,
    fdlChannelEnum: addT1Gateway?.fields.ciscoCatalyst6000T1VoIPGatewayT1.fields.fdlChannel.enum,
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
  for (const [choiceIndex, choice] of choices.entries()) {
    for (const name of choice.options.flat()) {
      const field = shape.fields?.[name];
      const memberships = Array.isArray(field?.choice)
        ? field.choice
        : field?.choice === undefined
          ? []
          : [field.choice];
      if (!memberships.includes(choiceIndex)) {
        broken.push(`${path} choice ${choiceIndex} -> ${name}`);
      }
    }
  }
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
  it('fails generation when an enum type has no lexical values', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cisco-axl-malformed-enum-'));
    const schemaRoot = join(temporaryRoot, 'schema');
    const versionRoot = join(schemaRoot, '15.0');
    const sourceRoot = join(REPO_ROOT, 'node_modules/cisco-axl/schema/15.0');
    try {
      await mkdir(versionRoot, { recursive: true });
      await Promise.all([
        symlink(join(sourceRoot, 'AXLAPI.wsdl'), join(versionRoot, 'AXLAPI.wsdl')),
        symlink(join(sourceRoot, 'AXLSoap.xsd'), join(versionRoot, 'AXLSoap.xsd')),
        writeFile(
          join(versionRoot, 'AXLEnums.xsd'),
          '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:simpleType name="Broken"></xsd:simpleType></xsd:schema>'
        ),
      ]);

      await expect(
        execFileAsync(
          process.execPath,
          [
            join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
            join(REPO_ROOT, 'scripts/generate-types.ts'),
            '--schema-dir',
            schemaRoot,
          ],
          { cwd: temporaryRoot, maxBuffer: 1024 * 1024 }
        )
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('Enum type Broken has no enumeration values'),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('regenerates all committed artifacts byte-for-byte from the Cisco sources', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cisco-axl-generator-'));
    try {
      await execFileAsync(
        process.execPath,
        [
          join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
          join(REPO_ROOT, 'scripts/generate-types.ts'),
          '--schema-dir',
          join(REPO_ROOT, 'node_modules/cisco-axl/schema'),
        ],
        { cwd: temporaryRoot, maxBuffer: 1024 * 1024 }
      );

      const committedFiles = await listGeneratedFiles(REPO_ROOT);
      const regeneratedFiles = await listGeneratedFiles(temporaryRoot);
      expect(committedFiles).toEqual(GENERATED_FILES);
      expect(regeneratedFiles).toEqual(GENERATED_FILES);

      for (const file of GENERATED_FILES) {
        const [committed, regenerated] = await Promise.all([
          readFile(join(REPO_ROOT, file)),
          readFile(join(temporaryRoot, file)),
        ]);
        expect(digest(regenerated), basename(file)).toBe(digest(committed));
        expect(regenerated.equals(committed), basename(file)).toBe(true);
      }

      for (const version of EXPECTED_VERSIONS) {
        const versionDir = join(REPO_ROOT, 'node_modules/cisco-axl/schema', version);
        const expectedDigests = support.AXL_SCHEMA_SOURCE_DIGESTS_BY_VERSION?.[version] as
          Record<string, string> | undefined;
        expect(expectedDigests).toEqual({
          wsdlSha256: digest(await readFile(join(versionDir, 'AXLAPI.wsdl'))),
          schemaSha256: digest(await readFile(join(versionDir, 'AXLSoap.xsd'))),
          enumsSha256: digest(await readFile(join(versionDir, 'AXLEnums.xsd'))),
        });
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('publishes deterministic operation and object catalogs for all supported versions', () => {
    expect(Object.keys(support.OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_TOP_LEVEL_OBJECTS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_OBJECT_OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(objects.AXL_ACTION_OPERATIONS_BY_VERSION ?? {})).toEqual(EXPECTED_VERSIONS);
    expect(Object.keys(classification.AXL_READ_ONLY_OPERATIONS_BY_VERSION ?? {})).toEqual(
      EXPECTED_VERSIONS
    );

    for (const version of EXPECTED_VERSIONS) {
      const versionSchemas = schemas.AXL_OPERATION_SCHEMAS_BY_VERSION?.[version] ?? {};
      const objectOperations = objects.AXL_OBJECT_OPERATIONS_BY_VERSION?.[version] ?? {};
      const actionOperations = objects.AXL_ACTION_OPERATIONS_BY_VERSION?.[version] ?? {};
      const getCallManager = versionSchemas.getCallManager;
      const deviceReset = versionSchemas.doDeviceReset;

      expect(support.OPERATIONS_BY_VERSION?.[version]).toEqual(
        [...(support.OPERATIONS_BY_VERSION?.[version] ?? [])].sort()
      );
      expect(support.OPERATIONS_BY_VERSION?.[version]).toEqual(
        expect.arrayContaining(CATALOG_OPERATIONS)
      );
      expect(Object.keys(versionSchemas).sort()).toEqual(support.OPERATIONS_BY_VERSION?.[version]);
      expect(
        Object.keys(schemas.AXL_OPERATION_METADATA_BY_VERSION?.[version] ?? {}).sort()
      ).toEqual(support.OPERATIONS_BY_VERSION?.[version]);
      expect(versionSchemas).toHaveProperty('executeSQLQuery.kind', 'other');
      expect(actionOperations).toHaveProperty('doDeviceReset');
      expect(getCallManager).toMatchObject({
        verb: 'get',
        object: 'CallManager',
        choices: [{ minOccurs: 1, maxOccurs: 1, options: [['name'], ['uuid']] }],
        fields: {
          name: { minOccurs: 1, maxOccurs: 1, choice: 0 },
          uuid: { minOccurs: 1, maxOccurs: 1, choice: 0 },
        },
      });
      expect(deviceReset).toMatchObject({
        verb: 'do',
        kind: 'action',
        fields: {
          deviceName: { required: true, minOccurs: 1 },
          isHardReset: { choice: 0 },
          deviceResetType: { choice: 0 },
        },
        choices: [{ options: [['isHardReset'], ['deviceResetType']] }],
      });
      expect(classification.AXL_READ_ONLY_OPERATIONS_BY_VERSION?.[version]).not.toContain(
        'doDeviceReset'
      );

      for (const [object, verbs] of Object.entries(objectOperations)) {
        for (const [verb, operation] of Object.entries(verbs)) {
          expect(versionSchemas[operation]).toMatchObject({ verb, object });
        }
      }
      for (const [operation, action] of Object.entries(actionOperations)) {
        const actionInfo = action as { verb?: string; object?: string | null };
        expect(versionSchemas[operation]).toMatchObject({
          verb: actionInfo.verb,
          kind: 'action',
          object: actionInfo.object ?? '',
        });
      }
      expect(classification.AXL_READ_ONLY_OPERATIONS_BY_VERSION?.[version]).toEqual(
        Object.entries(schemas.AXL_OPERATION_METADATA_BY_VERSION?.[version] ?? {})
          .filter(([operation, metadata]) => {
            const typed = metadata as { verb?: string; kind?: string };
            return (
              operation === 'executeSQLQuery' ||
              operation === 'executeSQLQueryInactive' ||
              (typed.kind === 'crud' && (typed.verb === 'get' || typed.verb === 'list'))
            );
          })
          .map(([operation]) => operation)
          .sort()
      );
    }
  });

  it.each(EXPECTED_VERSIONS)(
    'matches the %s schema golden for choices, arrays, nillability, enums, and opaque content',
    version => {
      expect(actualGolden(version)).toEqual(readGolden(version));
    }
  );

  it.each(EXPECTED_VERSIONS)('loads the %s payload independently', async version => {
    const pendingArtifacts = loadAxlVersionArtifacts(version);
    expect(loadAxlVersionArtifacts(version)).toBe(pendingArtifacts);
    const artifacts = await pendingArtifacts;
    expect(artifacts.version).toBe(version);
    expect(artifacts.operationSchemas.getCallManager).toBeDefined();
    expect(artifacts.operationSchemaDigest).toBe(
      schemas.AXL_OPERATION_SCHEMA_DIGESTS_BY_VERSION?.[version]
    );
  });

  it('detects a choice option without a field membership backlink', () => {
    const broken: string[] = [];
    collectBrokenChoiceLinks(
      {
        fields: { name: {} },
        choices: [{ options: [['name']] }],
      },
      'synthetic',
      broken
    );
    expect(broken).toEqual(['synthetic choice 0 -> name']);
  });

  it.each(EXPECTED_VERSIONS)(
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
