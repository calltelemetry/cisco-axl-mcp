import * as path from 'path';
import * as fs from 'fs/promises';
import * as strongSoap from 'strong-soap';

const WSDL = strongSoap.soap.WSDL;

function resolveSchemaDir(): string {
  const schemaDirArgIndex = process.argv.indexOf('--schema-dir');
  const customDir = schemaDirArgIndex !== -1 ? process.argv[schemaDirArgIndex + 1] : undefined;
  if (customDir) {
    return path.resolve(customDir);
  }
  // Default: use WSDL schemas bundled with the cisco-axl npm package
  return path.resolve(process.cwd(), 'node_modules/cisco-axl/schema');
}

const SCHEMA_DIR = resolveSchemaDir();
const OUT_WSDL_SUPPORT = path.resolve(process.cwd(), 'src/types/generated/wsdl-support.ts');
const OUT_AXL_OBJECTS = path.resolve(process.cwd(), 'src/types/generated/axl-objects.ts');
const OUT_OBJECTS_JSON = path.resolve(process.cwd(), 'generated/axl-top-level-objects.json');
const OUT_OPERATION_SCHEMAS = path.resolve(process.cwd(), 'src/types/generated/axl-operation-schemas.ts');

const CRUD_VERBS: CrudVerb[] = ['add', 'get', 'list', 'update', 'remove'];

/** Non-CRUD verb prefixes for action operations (apply, reset, restart, etc.) */
const ACTION_VERB_PREFIXES = ['apply', 'do', 'reset', 'restart', 'lock', 'wipe', 'assign', 'unassign'] as const;
type ActionVerbPrefix = (typeof ACTION_VERB_PREFIXES)[number];

// Objects that MUST exist in every WSDL version — build fails if missing.
// These are fundamental CUCM primitives used by CallTelemetry's core features.
const UNIVERSAL_OBJECTS = [
  'Phone',          // Device management, CTI port provisioning
  'Line',           // Directory numbers, DN conflict detection
  'User',           // End user management
  'AppUser',        // JTAPI application user provisioning
  'CtiRoutePoint',  // CTI route point provisioning
  'DevicePool',     // Phone discovery, branding
  'Css',            // Calling search space assignment
  'RoutePartition', // Partition management
];

type CrudVerb = 'add' | 'get' | 'list' | 'update' | 'remove';

interface ActionOpInfo {
  verb: ActionVerbPrefix;
  object: string | null;
}

/* ---------- Enum parsing ---------- */

async function parseEnums(enumsXsdPath: string): Promise<Record<string, string[]>> {
  const content = await fs.readFile(enumsXsdPath, 'utf8');
  const enums: Record<string, string[]> = {};
  const typeRegex = /<xsd:simpleType\s+name="([^"]+)">([\s\S]*?)<\/xsd:simpleType>/g;
  const valueRegex = /<xsd:enumeration\s+value="([^"]+)"/g;

  let typeMatch;
  while ((typeMatch = typeRegex.exec(content)) !== null) {
    const typeName = typeMatch[1]!;
    const typeBody = typeMatch[2]!;
    const values: string[] = [];
    let valueMatch;
    while ((valueMatch = valueRegex.exec(typeBody)) !== null) {
      values.push(valueMatch[1]!);
    }
    if (values.length > 0) {
      enums[typeName] = values;
    }
  }
  return enums;
}

/* ---------- Raw schema metadata cache ---------- */

interface RawFieldMeta {
  minOccurs: number;
  maxOccurs?: string;
  nillable?: boolean;
  defaultVal?: string;
  typeName?: string;
}

function buildTypeMetaCache(wsdl: any): Map<string, Map<string, RawFieldMeta>> {
  const cache = new Map<string, Map<string, RawFieldMeta>>();
  const schemas = wsdl.definitions.schemas;

  for (const ns of Object.keys(schemas)) {
    const schema = schemas[ns];
    if (!schema.complexTypes) continue;

    for (const [typeName, typeObj] of Object.entries(schema.complexTypes) as Array<[string, any]>) {
      const fieldMap = new Map<string, RawFieldMeta>();

      function walkRawChildren(obj: any): void {
        if (!obj.children) return;
        for (const child of obj.children) {
          if (child.$name && child.$type !== undefined) {
            const rawType = typeof child.$type === 'string'
              ? child.$type.replace(/^[^:]+:/, '')
              : undefined;
            fieldMap.set(child.$name, {
              minOccurs: child.$minOccurs !== undefined ? parseInt(String(child.$minOccurs), 10) : 1,
              maxOccurs: child.$maxOccurs,
              nillable: child.$nillable === 'true' || child.$nillable === true,
              defaultVal: child.$default,
              typeName: rawType,
            });
          }
          // Recurse into structural nodes (sequence, choice, complexContent, extension)
          // but NOT into named elements — those are field definitions, not containers
          if (!child.$name && child.children) {
            walkRawChildren(child);
          }
        }
      }

      walkRawChildren(typeObj);
      if (fieldMap.size > 0) {
        cache.set(typeName, fieldMap);
      }
    }
  }
  return cache;
}

/* ---------- Schema extraction ---------- */

interface FieldSchema {
  type: string;
  required?: true;
  nillable?: true;
  default?: string;
  typeName?: string;
  enum?: string[];
  enumType?: string;
  fields?: Record<string, FieldSchema>;
}

interface OperationSchema {
  verb: string;
  object: string;
  fields: Record<string, FieldSchema>;
}

const SIMPLE_TYPES = new Set(['string', 'boolean', 'integer', 'int', 'long', 'nonNegativeInteger']);

function mapJsType(jsType: string | undefined, typeName: string | undefined): string {
  if (jsType === 'boolean' || typeName === 'boolean') return 'boolean';
  if (jsType === 'number' || typeName === 'XInteger' || typeName === 'integer'
      || typeName === 'int' || typeName === 'long' || typeName === 'nonNegativeInteger') return 'integer';
  return 'string';
}

function buildFieldSchema(
  el: any,
  parentTypeName: string | undefined,
  depth: number,
  maxDepth: number,
  typeMetaCache: Map<string, Map<string, RawFieldMeta>>,
  enums: Record<string, string[]>,
): FieldSchema {
  const name: string | undefined = el.qname?.name;
  const typeName: string | undefined = el.type?.name;
  const hasChildren = Array.isArray(el.elements) && el.elements.length > 0;
  const isArray = !!el.isMany;
  const isComplex = !el.isSimple && hasChildren;

  const field: FieldSchema = {
    type: isArray ? 'array' : isComplex ? 'object' : mapJsType(el.jsType, typeName),
  };

  // Get metadata from raw schema (parent type → field name lookup)
  if (parentTypeName && name) {
    const parentMeta = typeMetaCache.get(parentTypeName);
    if (parentMeta) {
      const meta = parentMeta.get(name);
      if (meta) {
        if (meta.minOccurs >= 1) field.required = true;
        if (meta.defaultVal !== undefined) field.default = meta.defaultVal;
      }
    }
  }

  // Nillable from describe()
  if (el.isNillable) field.nillable = true;

  // Type annotation — enums vs complex type names
  if (typeName && !SIMPLE_TYPES.has(typeName)) {
    if (enums[typeName]) {
      const values = enums[typeName]!;
      if (values.length <= 30) {
        field.enum = values;
      } else {
        field.enumType = typeName;
      }
    } else {
      field.typeName = typeName;
    }
  }

  // Nested fields
  if (hasChildren && depth < maxDepth) {
    const fields: Record<string, FieldSchema> = {};
    for (const child of el.elements) {
      const childName: string | undefined = child.qname?.name;
      if (!childName) continue;
      fields[childName] = buildFieldSchema(child, typeName, depth + 1, maxDepth, typeMetaCache, enums);
    }
    field.fields = fields;
  }

  return field;
}

function extractOperationSchema(
  wsdl: any,
  opName: string,
  verb: string,
  objectName: string,
  typeMetaCache: Map<string, Map<string, RawFieldMeta>>,
  enums: Record<string, string[]>,
): OperationSchema | null {
  const binding = wsdl.definitions?.bindings?.AXLAPIBinding;
  if (!binding?.operations?.[opName]) return null;

  const opDef = binding.operations[opName];
  const desc = opDef.describe(wsdl);
  const inputElements: any[] = desc?.input?.body?.elements ?? [];

  // Build top-level fields. Try to find the request type name for metadata lookup.
  // Convention: addPhone → AddPhoneReq, getPhone → GetPhoneReq, etc.
  const reqTypeName = opName.charAt(0).toUpperCase() + opName.slice(1) + 'Req';

  const fields: Record<string, FieldSchema> = {};
  for (const el of inputElements) {
    const elName: string | undefined = el.qname?.name;
    if (!elName) continue;
    fields[elName] = buildFieldSchema(el, reqTypeName, 0, 3, typeMetaCache, enums);
  }

  // Parameter-less operations (e.g. getOSVersion) have empty fields — still valid
  return { verb, object: objectName, fields };
}

async function openWsdl(wsdlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    WSDL.open(
      wsdlPath,
      {
        attributesKey: 'attributes',
        valueKey: 'value',
      },
      (err: any, wsdl: any) => {
        if (err) reject(err);
        else resolve(wsdl);
      }
    );
  });
}

function extractOperationNames(wsdl: any): string[] {
  const defs = wsdl?.definitions;
  const service = defs?.services?.AXLAPIService;
  const port = service?.ports?.AXLPort;
  const bindingRef: unknown = port?.binding;
  if (!bindingRef) return [];

  let bindingName: string | undefined;
  if (typeof bindingRef === 'string') {
    bindingName = bindingRef.includes(':') ? bindingRef.split(':').pop() : bindingRef;
  } else if (typeof bindingRef === 'object' && bindingRef !== null) {
    const refObj = bindingRef as Record<string, unknown>;
    if (typeof refObj.$name === 'string') bindingName = refObj.$name;
    else if (typeof refObj.name === 'string') bindingName = refObj.name;
  }

  const binding =
    (bindingName && defs?.bindings?.[bindingName]) ||
    (typeof bindingRef === 'string' && defs?.bindings?.[bindingRef]) ||
    undefined;

  const operationsObj = binding?.operations;
  if (!operationsObj) return [];
  return Object.keys(operationsObj);
}

async function main() {
  const entries = await fs.readdir(SCHEMA_DIR, { withFileTypes: true });
  const versions = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const operationsByVersion: Record<string, string[]> = {};

  for (const version of versions) {
    const wsdlPath = path.join(SCHEMA_DIR, version, 'AXLAPI.wsdl');
    const wsdl = await openWsdl(wsdlPath);
    const opsList = extractOperationNames(wsdl).sort();
    operationsByVersion[version] = opsList;
  }

  const latestVersion = versions[versions.length - 1];
  if (!latestVersion) throw new Error('No WSDL versions found under schema/');
  const latestOps = operationsByVersion[latestVersion] ?? [];

  // Build full CRUD map from latest WSDL
  const objectOps: Record<string, Record<string, string>> = {};
  const crudRegex = /^(add|get|list|update|remove)(.+)$/;
  for (const op of latestOps) {
    const match = op.match(crudRegex);
    if (!match) continue;
    const verb = match[1] as CrudVerb;
    const objectName = match[2];
    if (!objectName) continue;
    objectOps[objectName] ||= {};
    objectOps[objectName][verb] = op;
  }

  // Build action (non-CRUD) operations map from latest WSDL
  // Maps operation name → { verb, object } where object is the matched top-level AXL object or null
  const actionOps: Record<string, ActionOpInfo> = {};
  const actionRegex = new RegExp(`^(${ACTION_VERB_PREFIXES.join('|')})(.+)$`);
  for (const op of latestOps) {
    if (crudRegex.test(op)) continue; // already handled as CRUD
    const match = op.match(actionRegex);
    if (!match) continue;
    const verb = match[1] as ActionVerbPrefix;
    const suffix = match[2];
    if (!suffix) continue;
    // Try to find a matching top-level object by suffix (e.g. "Phone" in "applyPhone")
    const object = objectOps[suffix] ? suffix : null;
    actionOps[op] = { verb, object };
    // Attach action to the object's operations map for easy discovery
    if (object) {
      objectOps[object] ||= {};
      objectOps[object][verb] = op;
    }
  }

  // Dynamically discover "core" objects — those with full CRUD (all 5 verbs)
  const coreObjects = Object.entries(objectOps)
    .filter(([, verbs]) => CRUD_VERBS.every(v => v in verbs))
    .map(([name]) => name)
    .sort();

  const coreOperations = coreObjects.flatMap(obj =>
    CRUD_VERBS.map(v => objectOps[obj]![v]!)
  );

  console.log(`Discovered ${coreObjects.length} core objects (full CRUD) out of ${Object.keys(objectOps).length} total, ${Object.keys(actionOps).length} action operations`);

  // Validate core operations exist across all WSDL versions
  // Tiered: UNIVERSAL_OBJECTS missing = hard error, others = warning
  const matrix: Record<string, Record<string, boolean>> = {};
  const warningsByVersion: Record<string, string[]> = {};

  for (const version of versions) {
    const ops = new Set(operationsByVersion[version] ?? []);
    const support: Record<string, boolean> = {};
    const missing: string[] = [];

    for (const op of coreOperations) {
      const ok = ops.has(op);
      support[op] = ok;
      if (!ok) missing.push(op);
    }

    matrix[version] = support;
    if (missing.length > 0) warningsByVersion[version] = missing;
  }

  // Check for critical failures (UNIVERSAL_OBJECTS missing)
  const criticalFailures: string[] = [];
  for (const [version, missing] of Object.entries(warningsByVersion)) {
    const critical = missing.filter(op =>
      UNIVERSAL_OBJECTS.some(obj => op.toLowerCase().includes(obj.toLowerCase()))
    );
    if (critical.length > 0) {
      criticalFailures.push(`- ${version}: ${critical.join(', ')}`);
    }
  }

  if (criticalFailures.length > 0) {
    throw new Error(`WSDL missing critical operations (UNIVERSAL_OBJECTS):\n${criticalFailures.join('\n')}`);
  }

  // Non-critical: warn about objects missing in older versions
  for (const [version, missing] of Object.entries(warningsByVersion)) {
    console.warn(`⚠ ${version}: ${missing.length} core operations unavailable: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`);
  }

  const wsdlSupportFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.

export const WSDL_VERSIONS = ${JSON.stringify(versions)} as const;
export type WsdlVersion = (typeof WSDL_VERSIONS)[number];

/** Objects with full CRUD support (add/get/list/update/remove) in the latest WSDL. */
export const CORE_AXL_OBJECTS = ${JSON.stringify(coreObjects)} as const;
export type CoreAxlObject = (typeof CORE_AXL_OBJECTS)[number];

/** All CRUD operations for core objects. */
export const CORE_AXL_OPERATIONS = ${JSON.stringify(coreOperations)} as const;
export type CoreAxlOperation = (typeof CORE_AXL_OPERATIONS)[number];

/** Objects that must exist in ALL WSDL versions (build fails if missing). */
export const UNIVERSAL_AXL_OBJECTS = ${JSON.stringify(UNIVERSAL_OBJECTS)} as const;

export const VERSION_SUPPORT_MATRIX = ${JSON.stringify(matrix, null, 2)} as const;
`;

  const objects = Object.keys(objectOps).sort((a, b) => a.localeCompare(b));
  const objectsJson = JSON.stringify({ version: latestVersion, objects }, null, 2);

  const axlObjectsFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Source WSDL version: ${latestVersion}

export const AXL_OBJECTS_SOURCE_WSDL_VERSION = ${JSON.stringify(latestVersion)} as const;

export const AXL_TOP_LEVEL_OBJECTS = ${JSON.stringify(objects)} as const;
export type AxlTopLevelObject = (typeof AXL_TOP_LEVEL_OBJECTS)[number];

export type CrudVerb = 'add' | 'get' | 'list' | 'update' | 'remove';
export type ActionVerbPrefix = 'apply' | 'do' | 'reset' | 'restart' | 'lock' | 'wipe' | 'assign' | 'unassign';

/** Maps each top-level AXL object to its available operations by verb (CRUD + action verbs where applicable). */
export const AXL_OBJECT_OPERATIONS: Record<string, Record<string, string>> = ${JSON.stringify(objectOps, null, 2)};

/** All non-CRUD action operations, keyed by operation name. */
export const AXL_ACTION_OPERATIONS: Record<string, { verb: ActionVerbPrefix; object: string | null }> = ${JSON.stringify(actionOps, null, 2)};
`;

  await fs.mkdir(path.dirname(OUT_WSDL_SUPPORT), { recursive: true });
  await fs.writeFile(OUT_WSDL_SUPPORT, wsdlSupportFile, 'utf8');

  await fs.mkdir(path.dirname(OUT_AXL_OBJECTS), { recursive: true });
  await fs.writeFile(OUT_AXL_OBJECTS, axlObjectsFile, 'utf8');

  await fs.mkdir(path.dirname(OUT_OBJECTS_JSON), { recursive: true });
  await fs.writeFile(OUT_OBJECTS_JSON, objectsJson, 'utf8');

  /* ---------- Operation schemas + enums ---------- */

  // Parse enums from AXLEnums.xsd
  const enumsPath = path.join(SCHEMA_DIR, latestVersion, 'AXLEnums.xsd');
  const enums = await parseEnums(enumsPath);
  const enumCount = Object.keys(enums).length;
  const enumValueCount = Object.values(enums).reduce((sum, v) => sum + v.length, 0);

  // Open the latest WSDL for schema extraction
  const latestWsdlPath = path.join(SCHEMA_DIR, latestVersion, 'AXLAPI.wsdl');
  const latestWsdl = await openWsdl(latestWsdlPath);
  const typeMetaCache = buildTypeMetaCache(latestWsdl);

  // Extract schemas for all mapped operations (CRUD + action)
  const operationSchemas: Record<string, OperationSchema> = {};
  let schemaCount = 0;
  for (const [objName, verbs] of Object.entries(objectOps)) {
    for (const [verb, opName] of Object.entries(verbs)) {
      const schema = extractOperationSchema(latestWsdl, opName, verb, objName, typeMetaCache, enums);
      if (schema) {
        operationSchemas[opName] = schema;
        schemaCount++;
      }
    }
  }

  // Also extract schemas for global action operations (those with no top-level object)
  for (const [opName, { verb, object }] of Object.entries(actionOps)) {
    if (object !== null) continue; // already handled above via objectOps
    const schema = extractOperationSchema(latestWsdl, opName, verb, '', typeMetaCache, enums);
    if (schema) {
      operationSchemas[opName] = schema;
      schemaCount++;
    }
  }

  // Separate large enums (> 30 values) that are actually referenced via enumType
  const referencedEnumTypes = new Set<string>();
  function collectEnumTypes(obj: Record<string, FieldSchema>): void {
    for (const field of Object.values(obj)) {
      if (field.enumType) referencedEnumTypes.add(field.enumType);
      if (field.fields) collectEnumTypes(field.fields);
    }
  }
  for (const schema of Object.values(operationSchemas)) {
    collectEnumTypes(schema.fields);
  }

  // Build the enum map — only include enums that are referenced as enumType (large ones)
  const largeEnums: Record<string, string[]> = {};
  for (const typeName of Array.from(referencedEnumTypes).sort()) {
    if (enums[typeName]) {
      largeEnums[typeName] = enums[typeName]!;
    }
  }

  const operationSchemasFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Source WSDL version: ${latestVersion}
// ${schemaCount} operation schemas, ${enumCount} enum types (${enumValueCount} values)

export const AXL_SCHEMAS_SOURCE_VERSION = ${JSON.stringify(latestVersion)} as const;

export interface FieldSchema {
  type: string;
  required?: true;
  nillable?: true;
  default?: string;
  typeName?: string;
  enum?: string[];
  enumType?: string;
  fields?: Record<string, FieldSchema>;
}

export interface OperationSchema {
  verb: string;
  /** Top-level AXL object this operation targets. Empty string for global action operations (e.g. doDeviceReset, doLdapSync) that have no specific object. */
  object: string;
  fields: Record<string, FieldSchema>;
}

export const AXL_ENUMS: Record<string, string[]> = ${JSON.stringify(largeEnums, null, 2)};

export const AXL_OPERATION_SCHEMAS: Record<string, OperationSchema> = ${JSON.stringify(operationSchemas, null, 2)};
`;

  await fs.mkdir(path.dirname(OUT_OPERATION_SCHEMAS), { recursive: true });
  await fs.writeFile(OUT_OPERATION_SCHEMAS, operationSchemasFile, 'utf8');

  console.log(`Generated ${schemaCount} operation schemas (${Object.keys(actionOps).length} action ops), ${coreObjects.length} core objects, ${enumCount} enums (${Object.keys(largeEnums).length} large), ${typeMetaCache.size} type definitions`);
}

main().catch(err => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
