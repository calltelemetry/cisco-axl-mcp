import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as strongSoap from 'strong-soap';

const WSDL = strongSoap.soap.WSDL;

function resolveSchemaDir(): string {
  const schemaDirArgIndex = process.argv.indexOf('--schema-dir');
  const customDir = schemaDirArgIndex !== -1 ? process.argv[schemaDirArgIndex + 1] : undefined;
  return customDir
    ? path.resolve(customDir)
    : path.resolve(process.cwd(), 'node_modules/cisco-axl/schema');
}

const SCHEMA_DIR = resolveSchemaDir();
const OUT_WSDL_SUPPORT = path.resolve(process.cwd(), 'src/types/generated/wsdl-support.ts');
const OUT_AXL_OBJECTS = path.resolve(process.cwd(), 'src/types/generated/axl-objects.ts');
const OUT_OBJECTS_JSON = path.resolve(process.cwd(), 'generated/axl-top-level-objects.json');
const OUT_GENERATED_TYPES = path.resolve(
  process.cwd(),
  'src/types/generated/axl-generated-types.ts'
);
const OUT_LATEST = path.resolve(process.cwd(), 'src/types/generated/axl-latest.ts');
const OUT_VERSION_LOADER = path.resolve(process.cwd(), 'src/types/generated/axl-version-loader.ts');
const OUT_VERSIONS_DIR = path.resolve(process.cwd(), 'src/types/generated/versions');
const OUT_OPERATION_SCHEMAS = path.resolve(
  process.cwd(),
  'src/types/generated/axl-operation-schemas.ts'
);

const CRUD_VERBS = ['add', 'get', 'list', 'update', 'remove'] as const;
const ACTION_VERB_PREFIXES = [
  'apply',
  'do',
  'reset',
  'restart',
  'lock',
  'wipe',
  'assign',
  'unassign',
] as const;

const UNIVERSAL_OBJECTS = [
  'Phone',
  'Line',
  'User',
  'AppUser',
  'CtiRoutePoint',
  'DevicePool',
  'Css',
  'RoutePartition',
] as const;

type CrudVerb = (typeof CRUD_VERBS)[number];
type ActionVerbPrefix = (typeof ACTION_VERB_PREFIXES)[number];
type Occurs = number | 'unbounded';

interface ActionOpInfo {
  verb: ActionVerbPrefix;
  object: string | null;
}

interface SourceDigests {
  wsdlSha256: string;
  schemaSha256: string;
  enumsSha256: string;
}

interface ChoiceSchema {
  minOccurs: number;
  maxOccurs: Occurs;
  options: string[][];
}

interface SequenceSchema {
  minOccurs: number;
  maxOccurs: Occurs;
  fields: string[];
}

interface AttributeSchema {
  type: string;
  required?: true;
  typeName?: string;
  enum?: string[];
  enumType?: string;
}

interface FieldSchema {
  type: string;
  minOccurs: number;
  maxOccurs: Occurs;
  nillable: boolean;
  required?: true;
  default?: string;
  typeName?: string;
  enum?: string[];
  enumType?: string;
  fields?: Record<string, FieldSchema>;
  choices?: ChoiceSchema[];
  sequences?: SequenceSchema[];
  attributes?: Record<string, AttributeSchema>;
  items?: FieldSchema;
  choice?: number | number[];
  sequence?: number | number[];
  opaque?: true;
  ref?: string;
}

interface SchemaShape {
  fields: Record<string, FieldSchema>;
  choices: ChoiceSchema[];
  sequences: SequenceSchema[];
  attributes: Record<string, AttributeSchema>;
}

interface OperationMetadata {
  verb: string;
  object: string;
  kind: 'crud' | 'action' | 'other';
}

interface OperationSchema extends OperationMetadata, SchemaShape {}

interface SchemaRegistry {
  complexTypes: Map<string, any>;
  elements: Map<string, any>;
}

interface VersionArtifacts {
  operations: string[];
  objects: string[];
  objectOperations: Record<string, Record<string, string>>;
  actionOperations: Record<string, ActionOpInfo>;
  operationMetadata: Record<string, OperationMetadata>;
  operationSchemas: Record<string, OperationSchema>;
  largeEnums: Record<string, string[]>;
  sourceDigests: SourceDigests;
  operationSchemaDigest: string;
  typeCount: number;
  enumCount: number;
  enumValueCount: number;
}

const NUMERIC_TYPES = new Set([
  'byte',
  'decimal',
  'double',
  'float',
  'int',
  'integer',
  'long',
  'negativeInteger',
  'nonNegativeInteger',
  'nonPositiveInteger',
  'positiveInteger',
  'short',
  'unsignedByte',
  'unsignedInt',
  'unsignedLong',
  'unsignedShort',
  'XInteger',
]);

const BUILTIN_TYPES = new Set([
  'anyType',
  'base64Binary',
  'boolean',
  'date',
  'dateTime',
  'duration',
  'hexBinary',
  'string',
  'time',
  ...NUMERIC_TYPES,
]);
// Cisco's XInteger is numerically represented but remains useful type metadata.
BUILTIN_TYPES.delete('XInteger');

function localName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/^[^:]+:/, '');
}

function nodeKind(node: any): string {
  return String(node?.name ?? node?.constructor?.name ?? '').toLowerCase();
}

function parseMinOccurs(node: any): number {
  const value = node?.$minOccurs;
  if (value === undefined) return 1;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid minOccurs ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseMaxOccurs(node: any): Occurs {
  const value = node?.$maxOccurs;
  if (value === undefined) return 1;
  if (value === 'unbounded') return 'unbounded';
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid maxOccurs ${JSON.stringify(value)}`);
  }
  return parsed;
}

function isMany(maxOccurs: Occurs): boolean {
  return maxOccurs === 'unbounded' || maxOccurs > 1;
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.max(leftPoints.length, rightPoints.length); index++) {
    if (leftPoints[index] === undefined) return -1;
    if (rightPoints[index] === undefined) return 1;
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return compareCodePoints(left, right);
}

function stableRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => compareCodePoints(left, right))
  ) as Record<string, T>;
}

async function parseEnums(enumsXsdPath: string): Promise<Record<string, string[]>> {
  const content = await fs.readFile(enumsXsdPath, 'utf8');
  const enums = new Map<string, string[]>();
  const typeRegex = /<xsd:simpleType\b([^>]*)>([\s\S]*?)<\/xsd:simpleType\s*>/g;
  const typeStarts = content.match(/<xsd:simpleType\b/g)?.length ?? 0;
  const typeEnds = content.match(/<\/xsd:simpleType\s*>/g)?.length ?? 0;
  const typeMatches = [...content.matchAll(typeRegex)];
  if (typeStarts !== typeEnds || typeMatches.length !== typeStarts) {
    throw new Error(`Malformed simpleType structure in ${enumsXsdPath}`);
  }

  for (const typeMatch of typeMatches) {
    const attributes = typeMatch[1];
    const typeBody = typeMatch[2];
    const typeName = attributes?.match(/\bname="([^"]+)"/)?.[1];
    if (!typeName || typeBody === undefined) throw new Error(`Malformed enum in ${enumsXsdPath}`);
    if (enums.has(typeName)) throw new Error(`Duplicate enum type ${typeName} in ${enumsXsdPath}`);

    const valueStarts = typeBody.match(/<xsd:enumeration\b/g)?.length ?? 0;
    const valueMatches = [...typeBody.matchAll(/<xsd:enumeration\b([^>]*)\/?>/g)];
    if (valueStarts === 0) throw new Error(`Enum type ${typeName} has no enumeration values`);
    if (valueMatches.length !== valueStarts) {
      throw new Error(`Malformed enumeration structure in ${typeName}`);
    }
    const values = valueMatches.map(match => {
      const value = match[1]?.match(/\bvalue="([^"]*)"/)?.[1];
      if (value === undefined) throw new Error(`Enumeration without a value in ${typeName}`);
      return decodeXmlEntities(value);
    });
    enums.set(typeName, values);
  }

  return stableRecord(enums.entries());
}

function decodeXmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, reference: string) => {
    const named = namedEntities[reference];
    if (named !== undefined) return named;

    const codePoint = reference.startsWith('#x')
      ? Number.parseInt(reference.slice(2), 16)
      : reference.startsWith('#')
        ? Number.parseInt(reference.slice(1), 10)
        : Number.NaN;
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new Error(`Unsupported XML entity ${entity}`);
    }
    return String.fromCodePoint(codePoint);
  });
}

async function openWsdl(wsdlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    WSDL.open(
      wsdlPath,
      { attributesKey: 'attributes', valueKey: 'value' },
      (error: unknown, wsdl: any) => (error ? reject(error) : resolve(wsdl))
    );
  });
}

function buildSchemaRegistry(wsdl: any): SchemaRegistry {
  const complexTypes = new Map<string, any>();
  const elements = new Map<string, any>();
  const schemas = wsdl?.definitions?.schemas ?? {};

  for (const namespace of Object.keys(schemas).sort(compareCodePoints)) {
    const schema = schemas[namespace];
    for (const [name, value] of Object.entries(schema?.complexTypes ?? {})) {
      if (!complexTypes.has(name)) complexTypes.set(name, value);
    }
    for (const [name, value] of Object.entries(schema?.elements ?? {})) {
      if (!elements.has(name)) elements.set(name, value);
    }
  }

  return { complexTypes, elements };
}

function extractOperationNames(wsdl: any): string[] {
  const definitions = wsdl?.definitions;
  const port = definitions?.services?.AXLAPIService?.ports?.AXLPort;
  const bindingRef: unknown = port?.binding;
  if (!bindingRef) return [];

  let bindingName: string | undefined;
  if (typeof bindingRef === 'string') {
    bindingName = localName(bindingRef);
  } else if (typeof bindingRef === 'object' && bindingRef !== null) {
    const ref = bindingRef as Record<string, unknown>;
    bindingName =
      typeof ref.$name === 'string'
        ? ref.$name
        : typeof ref.name === 'string'
          ? ref.name
          : undefined;
  }

  const binding =
    (bindingName && definitions?.bindings?.[bindingName]) ||
    (typeof bindingRef === 'string' && definitions?.bindings?.[bindingRef]);
  return Object.keys(binding?.operations ?? {}).sort(compareCodePoints);
}

function discoverOperations(operations: string[]): {
  objects: string[];
  objectOperations: Record<string, Record<string, string>>;
  actionOperations: Record<string, ActionOpInfo>;
  operationMetadata: Record<string, OperationMetadata>;
} {
  const objectOperations: Record<string, Record<string, string>> = {};
  const actionOperations: Record<string, ActionOpInfo> = {};
  const metadata: Record<string, OperationMetadata> = {};
  const crudRegex = /^(add|get|list|update|remove)(.+)$/;
  const actionRegex = new RegExp(`^(${ACTION_VERB_PREFIXES.join('|')})(.+)$`);

  for (const operation of operations) {
    const match = operation.match(crudRegex);
    if (!match) continue;
    const verb = match[1] as CrudVerb;
    const object = match[2]!;
    objectOperations[object] ||= {};
    objectOperations[object]![verb] = operation;
  }

  for (const operation of operations) {
    const crudMatch = operation.match(crudRegex);
    if (crudMatch) {
      metadata[operation] = {
        verb: crudMatch[1]!,
        object: crudMatch[2]!,
        kind: 'crud',
      };
      continue;
    }

    const actionMatch = operation.match(actionRegex);
    if (actionMatch) {
      const verb = actionMatch[1] as ActionVerbPrefix;
      const suffix = actionMatch[2]!;
      const object = objectOperations[suffix] ? suffix : null;
      actionOperations[operation] = { verb, object };
      if (object) objectOperations[object]![verb] = operation;
      metadata[operation] = { verb, object: object ?? '', kind: 'action' };
      continue;
    }

    const verb = operation.match(/^[a-z]+/)?.[0] ?? operation;
    metadata[operation] = { verb, object: '', kind: 'other' };
  }

  const sortedObjectOperations = stableRecord(
    Object.entries(objectOperations).map(([object, verbs]) => [
      object,
      stableRecord(Object.entries(verbs)),
    ])
  );

  return {
    objects: Object.keys(sortedObjectOperations),
    objectOperations: sortedObjectOperations,
    actionOperations: stableRecord(Object.entries(actionOperations)),
    operationMetadata: stableRecord(Object.entries(metadata)),
  };
}

function emptyShape(): SchemaShape {
  return { fields: {}, choices: [], sequences: [], attributes: {} };
}

function sameSchema(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendChoice(field: FieldSchema, choiceIndex: number): void {
  if (field.choice === undefined) field.choice = choiceIndex;
  else if (Array.isArray(field.choice)) field.choice.push(choiceIndex);
  else field.choice = [field.choice, choiceIndex];
  delete field.required;
}

function appendSequence(field: FieldSchema, sequenceIndex: number): void {
  if (field.sequence === undefined) field.sequence = sequenceIndex;
  else if (Array.isArray(field.sequence)) field.sequence.push(sequenceIndex);
  else field.sequence = [field.sequence, sequenceIndex];
}

function shiftChoiceIndexes(shape: SchemaShape, offset: number): void {
  if (offset === 0) return;
  for (const field of Object.values(shape.fields)) {
    if (typeof field.choice === 'number') field.choice += offset;
    else if (Array.isArray(field.choice)) field.choice = field.choice.map(value => value + offset);
  }
}

function shiftSequenceIndexes(shape: SchemaShape, offset: number): void {
  if (offset === 0) return;
  for (const field of Object.values(shape.fields)) {
    if (typeof field.sequence === 'number') field.sequence += offset;
    else if (Array.isArray(field.sequence)) {
      field.sequence = field.sequence.map(value => value + offset);
    }
  }
}

function mergeShape(target: SchemaShape, source: SchemaShape, context: string): void {
  const choiceOffset = target.choices.length;
  shiftChoiceIndexes(source, choiceOffset);
  target.choices.push(...source.choices);
  const sequenceOffset = target.sequences.length;
  shiftSequenceIndexes(source, sequenceOffset);
  target.sequences.push(...source.sequences);

  for (const [name, field] of Object.entries(source.fields)) {
    const existing = target.fields[name];
    if (existing && !sameSchema(existing, field)) {
      throw new Error(`Cannot safely merge duplicate field ${context}.${name}`);
    }
    target.fields[name] = existing ?? field;
  }

  for (const [name, attribute] of Object.entries(source.attributes)) {
    const existing = target.attributes[name];
    if (existing && !sameSchema(existing, attribute)) {
      throw new Error(`Cannot safely merge duplicate attribute ${context}.@${name}`);
    }
    target.attributes[name] = existing ?? attribute;
  }
}

function createSchemaBuilder(registry: SchemaRegistry, enums: Record<string, string[]>) {
  function annotateType(schema: FieldSchema | AttributeSchema, typeName: string): void {
    const values = enums[typeName];
    if (values) {
      if (values.length <= 30) schema.enum = values;
      else schema.enumType = typeName;
    } else if (!BUILTIN_TYPES.has(typeName)) {
      schema.typeName = typeName;
    }
  }

  function primitiveType(typeName: string | undefined): string {
    if (typeName === 'boolean') return 'boolean';
    if (typeName && NUMERIC_TYPES.has(typeName)) return 'integer';
    return 'string';
  }

  function buildAttribute(node: any): AttributeSchema {
    const typeName = localName(node?.$type) ?? 'string';
    const schema: AttributeSchema = { type: primitiveType(typeName) };
    if (node?.$use === 'required') schema.required = true;
    annotateType(schema, typeName);
    return schema;
  }

  function findSimpleContent(node: any): any | undefined {
    return node?.children?.find((child: any) => nodeKind(child) === 'simplecontent');
  }

  function containsWildcard(node: any): boolean {
    return (
      nodeKind(node) === 'any' ||
      (node?.children ?? []).some((child: any) => containsWildcard(child))
    );
  }

  function buildComplexScalar(typeNode: any, typeName: string): FieldSchema {
    const simpleContent = findSimpleContent(typeNode);
    const contentNode = simpleContent?.children?.find((child: any) =>
      ['extension', 'restriction'].includes(nodeKind(child))
    );
    const baseTypeName = localName(contentNode?.$base) ?? 'string';
    const schema: FieldSchema = {
      type: primitiveType(baseTypeName),
      minOccurs: 1,
      maxOccurs: 1,
      nillable: false,
      typeName,
    };
    annotateType(schema, baseTypeName);

    const attributes: Record<string, AttributeSchema> = {};
    for (const child of contentNode?.children ?? []) {
      if (nodeKind(child) === 'attribute') {
        const name = child.$name;
        if (!name) throw new Error(`Unnamed attribute in ${typeName}`);
        attributes[name] = buildAttribute(child);
      } else if (!['annotation', 'documentation'].includes(nodeKind(child))) {
        throw new Error(`Unsupported ${nodeKind(child)} in simple content ${typeName}`);
      }
    }
    if (Object.keys(attributes).length > 0) schema.attributes = attributes;
    return schema;
  }

  function buildBaseValue(
    typeName: string | undefined,
    inlineType: any,
    stack: Set<string>
  ): FieldSchema {
    const complexType = inlineType ?? (typeName ? registry.complexTypes.get(typeName) : undefined);
    if (typeName === 'XVendorConfig' || (complexType && containsWildcard(complexType))) {
      return {
        type: 'opaque',
        minOccurs: 1,
        maxOccurs: 1,
        nillable: false,
        typeName,
        opaque: true,
      };
    }

    if (complexType) {
      if (typeName && stack.has(typeName)) {
        return {
          type: 'reference',
          minOccurs: 1,
          maxOccurs: 1,
          nillable: false,
          typeName,
          ref: typeName,
        };
      }
      const nextStack = new Set(stack);
      if (typeName) nextStack.add(typeName);
      if (findSimpleContent(complexType)) {
        return buildComplexScalar(complexType, typeName ?? 'anonymous');
      }
      const shape = buildShape(complexType, nextStack, typeName ?? 'anonymous', true);
      const schema: FieldSchema = {
        type: 'object',
        minOccurs: 1,
        maxOccurs: 1,
        nillable: false,
        fields: shape.fields,
      };
      if (typeName) schema.typeName = typeName;
      if (shape.choices.length > 0) schema.choices = shape.choices;
      if (shape.sequences.length > 0) schema.sequences = shape.sequences;
      if (Object.keys(shape.attributes).length > 0) schema.attributes = shape.attributes;
      return schema;
    }

    const normalizedTypeName = typeName ?? 'string';
    const schema: FieldSchema = {
      type: primitiveType(normalizedTypeName),
      minOccurs: 1,
      maxOccurs: 1,
      nillable: false,
    };
    annotateType(schema, normalizedTypeName);
    return schema;
  }

  function buildElement(node: any, stack: Set<string>, requiredContext: boolean): FieldSchema {
    const minOccurs = parseMinOccurs(node);
    const maxOccurs = parseMaxOccurs(node);
    const nillable = node?.$nillable === true || node?.$nillable === 'true';
    const typeName = localName(node?.$type);
    const inlineType = node?.children?.find((child: any) => nodeKind(child) === 'complextype');
    const item = buildBaseValue(typeName, inlineType, stack);

    let field: FieldSchema;
    if (isMany(maxOccurs)) {
      field = {
        type: 'array',
        minOccurs,
        maxOccurs,
        nillable,
        items: item,
      };
      if (item.typeName) field.typeName = item.typeName;
      if (item.fields) field.fields = item.fields;
      if (item.choices) field.choices = item.choices;
      if (item.sequences) field.sequences = item.sequences;
      if (item.attributes) field.attributes = item.attributes;
    } else {
      field = { ...item, minOccurs, maxOccurs, nillable };
    }

    if (requiredContext && minOccurs >= 1) field.required = true;
    if (node?.$default !== undefined) field.default = String(node.$default);
    return field;
  }

  function buildChoice(
    node: any,
    stack: Set<string>,
    context: string,
    requiredContext: boolean
  ): SchemaShape {
    const result = emptyShape();
    const choiceIndex = 0;
    const options: string[][] = [];

    for (const child of node.children ?? []) {
      if (['annotation', 'documentation'].includes(nodeKind(child))) continue;
      const option = buildShape(child, stack, `${context}.choice`, false);
      const names = Object.keys(option.fields);
      if (names.length === 0) {
        throw new Error(`Choice option without fields in ${context}`);
      }
      for (const field of Object.values(option.fields)) appendChoice(field, choiceIndex);
      options.push(names);
      mergeShape(result, option, context);
    }

    result.choices.unshift({
      minOccurs: parseMinOccurs(node),
      maxOccurs: parseMaxOccurs(node),
      options,
    });
    if (!requiredContext || parseMinOccurs(node) === 0) {
      for (const field of Object.values(result.fields)) delete field.required;
    }
    return result;
  }

  function buildSequence(
    node: any,
    stack: Set<string>,
    context: string,
    requiredContext: boolean
  ): SchemaShape {
    const minOccurs = parseMinOccurs(node);
    const maxOccurs = parseMaxOccurs(node);
    if (maxOccurs !== 1) {
      throw new Error(
        `Unsupported repeating sequence in ${context}: minOccurs=${minOccurs}, maxOccurs=${maxOccurs}`
      );
    }

    const result = emptyShape();
    const childRequiredContext = requiredContext && minOccurs >= 1;
    for (const child of node.children ?? []) {
      const childKind = nodeKind(child);
      if (['annotation', 'documentation'].includes(childKind)) continue;
      mergeShape(result, buildShape(child, stack, context, childRequiredContext), context);
    }

    if (minOccurs !== 1) {
      const sequenceIndex = result.sequences.length;
      const fields = Object.keys(result.fields);
      result.sequences.push({ minOccurs, maxOccurs, fields });
      for (const field of Object.values(result.fields)) appendSequence(field, sequenceIndex);
    }
    return result;
  }

  function buildShape(
    node: any,
    stack: Set<string>,
    context: string,
    requiredContext: boolean
  ): SchemaShape {
    const result = emptyShape();
    const kind = nodeKind(node);

    if (kind === 'element') {
      const name = node.$name;
      if (!name) throw new Error(`Unnamed element in ${context}`);
      result.fields[name] = buildElement(node, stack, requiredContext);
      return result;
    }
    if (kind === 'attribute') {
      const name = node.$name;
      if (!name) throw new Error(`Unnamed attribute in ${context}`);
      result.attributes[name] = buildAttribute(node);
      return result;
    }
    if (kind === 'choice') {
      return buildChoice(node, stack, context, requiredContext);
    }
    if (kind === 'sequence') {
      return buildSequence(node, stack, context, requiredContext);
    }
    if (kind === 'any') {
      throw new Error(`Unsupported wildcard content in ${context}; only XVendorConfig is opaque`);
    }
    if (['annotation', 'documentation'].includes(kind)) return result;

    if (kind === 'extension') {
      const baseTypeName = localName(node.$base);
      const baseType = baseTypeName ? registry.complexTypes.get(baseTypeName) : undefined;
      if (baseType) {
        if (stack.has(baseTypeName!)) {
          throw new Error(`Cyclic complex-content extension ${context} -> ${baseTypeName}`);
        }
        const baseStack = new Set(stack);
        baseStack.add(baseTypeName!);
        mergeShape(
          result,
          buildShape(baseType, baseStack, `${context}<${baseTypeName}>`, requiredContext),
          context
        );
      } else if (baseTypeName && !BUILTIN_TYPES.has(baseTypeName)) {
        throw new Error(`Unknown extension base ${baseTypeName} in ${context}`);
      }
    }

    const structuralKinds = new Set(['complextype', 'complexcontent', 'extension', 'restriction']);
    if (!structuralKinds.has(kind)) {
      throw new Error(`Unsupported schema construct ${kind || '<unknown>'} in ${context}`);
    }

    for (const child of node.children ?? []) {
      if (kind === 'extension' && nodeKind(child) === 'attribute') {
        const name = child.$name;
        if (!name) throw new Error(`Unnamed attribute in ${context}`);
        result.attributes[name] = buildAttribute(child);
        continue;
      }
      const childKind = nodeKind(child);
      if (['annotation', 'documentation'].includes(childKind)) continue;
      if (childKind === 'simplecontent') {
        throw new Error(`Simple content reached object shape in ${context}`);
      }
      mergeShape(result, buildShape(child, stack, context, requiredContext), context);
    }
    return result;
  }

  function buildOperation(operation: string, metadata: OperationMetadata): OperationSchema {
    const rootElement = registry.elements.get(operation);
    if (!rootElement) throw new Error(`No request element found for operation ${operation}`);
    const requestTypeName = localName(rootElement.$type);
    const inlineType = rootElement.children?.find(
      (child: any) => nodeKind(child) === 'complextype'
    );
    const requestType =
      inlineType ?? (requestTypeName ? registry.complexTypes.get(requestTypeName) : undefined);

    if (!requestType) {
      if (requestTypeName && BUILTIN_TYPES.has(requestTypeName)) {
        return { ...metadata, ...emptyShape() };
      }
      throw new Error(
        `No request type found for operation ${operation} (${requestTypeName ?? 'inline'})`
      );
    }

    const stack = new Set<string>();
    if (requestTypeName) stack.add(requestTypeName);
    return {
      ...metadata,
      ...buildShape(requestType, stack, operation, true),
    };
  }

  return { buildOperation };
}

function collectEnumTypesFromField(field: FieldSchema, target: Set<string>): void {
  if (field.enumType) target.add(field.enumType);
  if (field.items) collectEnumTypesFromField(field.items, target);
  for (const child of Object.values(field.fields ?? {})) collectEnumTypesFromField(child, target);
  for (const attribute of Object.values(field.attributes ?? {})) {
    if (attribute.enumType) target.add(attribute.enumType);
  }
}

async function buildVersion(version: string): Promise<VersionArtifacts> {
  const versionDir = path.join(SCHEMA_DIR, version);
  const wsdlPath = path.join(versionDir, 'AXLAPI.wsdl');
  const schemaPath = path.join(versionDir, 'AXLSoap.xsd');
  const enumsPath = path.join(versionDir, 'AXLEnums.xsd');
  const [wsdlContent, schemaContent, enumsContent, wsdl, enums] = await Promise.all([
    fs.readFile(wsdlPath),
    fs.readFile(schemaPath),
    fs.readFile(enumsPath),
    openWsdl(wsdlPath),
    parseEnums(enumsPath),
  ]);
  const operations = extractOperationNames(wsdl);
  const discovery = discoverOperations(operations);
  const registry = buildSchemaRegistry(wsdl);
  const builder = createSchemaBuilder(registry, enums);
  const operationSchemas: Record<string, OperationSchema> = {};

  for (const operation of operations) {
    const metadata = discovery.operationMetadata[operation];
    if (!metadata) throw new Error(`No metadata for operation ${operation}`);
    operationSchemas[operation] = builder.buildOperation(operation, metadata);
  }

  const referencedEnumTypes = new Set<string>();
  for (const operationSchema of Object.values(operationSchemas)) {
    for (const field of Object.values(operationSchema.fields)) {
      collectEnumTypesFromField(field, referencedEnumTypes);
    }
  }
  const largeEnums = stableRecord(
    [...referencedEnumTypes]
      .filter(typeName => enums[typeName])
      .map(typeName => [typeName, enums[typeName]!] as const)
  );
  const enumValueCount = Object.values(enums).reduce((sum, values) => sum + values.length, 0);

  return {
    operations,
    objects: discovery.objects,
    objectOperations: discovery.objectOperations,
    actionOperations: discovery.actionOperations,
    operationMetadata: discovery.operationMetadata,
    operationSchemas,
    largeEnums,
    sourceDigests: {
      wsdlSha256: sha256(wsdlContent),
      schemaSha256: sha256(schemaContent),
      enumsSha256: sha256(enumsContent),
    },
    operationSchemaDigest: sha256(JSON.stringify(operationSchemas)),
    typeCount: registry.complexTypes.size,
    enumCount: Object.keys(enums).length,
    enumValueCount,
  };
}

function versionSymbolSuffix(version: string): string {
  return version.replace(/[^\dA-Za-z]+/g, '_');
}

function versionFileSlug(version: string): string {
  return version.replace(/[^\dA-Za-z]+/g, '-');
}

function renderVersionMap(versions: string[], symbolPrefix: string): string {
  return `{
${versions
  .map(version => `  ${JSON.stringify(version)}: ${symbolPrefix}_${versionSymbolSuffix(version)},`)
  .join('\n')}
}`;
}

function renderVersionImports(versions: string[], symbolPrefixes: string[]): string {
  return versions
    .map(version => {
      const suffix = versionSymbolSuffix(version);
      const symbols = symbolPrefixes.map(prefix => `${prefix}_${suffix}`).join(', ');
      return `import { ${symbols} } from './versions/axl-version-${versionFileSlug(version)}';`;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const entries = await fs.readdir(SCHEMA_DIR, { withFileTypes: true });
  const versions = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort(compareVersions);
  const latestVersion = versions.at(-1);
  if (!latestVersion) throw new Error('No WSDL versions found under schema/');

  const artifactsByVersion: Record<string, VersionArtifacts> = {};
  for (const version of versions) {
    artifactsByVersion[version] = await buildVersion(version);
  }
  const latest = artifactsByVersion[latestVersion]!;

  const operationsByVersion = stableRecord(
    versions.map(version => [version, artifactsByVersion[version]!.operations] as const)
  );
  const sourceDigestsByVersion = stableRecord(
    versions.map(version => [version, artifactsByVersion[version]!.sourceDigests] as const)
  );
  const topLevelObjectsByVersion = stableRecord(
    versions.map(version => [version, artifactsByVersion[version]!.objects] as const)
  );
  const coreObjects = latest.objects.filter(object =>
    CRUD_VERBS.every(verb => verb in latest.objectOperations[object]!)
  );
  const coreOperations = coreObjects.flatMap(object =>
    CRUD_VERBS.map(verb => latest.objectOperations[object]![verb]!)
  );
  const matrix: Record<string, Record<string, boolean>> = {};
  const criticalFailures: string[] = [];

  for (const version of versions) {
    const operations = new Set(artifactsByVersion[version]!.operations);
    matrix[version] = Object.fromEntries(
      coreOperations.map(operation => [operation, operations.has(operation)])
    );
    const missingUniversal = UNIVERSAL_OBJECTS.flatMap(object =>
      CRUD_VERBS.map(verb => `${verb}${object}`).filter(operation => !operations.has(operation))
    );
    if (missingUniversal.length > 0) {
      criticalFailures.push(`- ${version}: ${missingUniversal.join(', ')}`);
    }
  }
  if (criticalFailures.length > 0) {
    throw new Error(
      `WSDL missing critical operations (UNIVERSAL_OBJECTS):\n${criticalFailures.join('\n')}`
    );
  }

  const wsdlSupportFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.

export const WSDL_VERSIONS = ${JSON.stringify(versions)} as const;
export type WsdlVersion = (typeof WSDL_VERSIONS)[number];

/** Complete, sorted operation catalog for every bundled WSDL version. */
export const OPERATIONS_BY_VERSION = ${JSON.stringify(operationsByVersion, null, 2)} as const;

/** SHA-256 digests of the exact WSDL, schema, and enum inputs used for each version. */
export const AXL_SCHEMA_SOURCE_DIGESTS_BY_VERSION = ${JSON.stringify(sourceDigestsByVersion, null, 2)} as const;

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

  const generatedTypesFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.

import type { WsdlVersion } from './wsdl-support';

export type CrudVerb = 'add' | 'get' | 'list' | 'update' | 'remove';
export type ActionVerbPrefix = 'apply' | 'do' | 'reset' | 'restart' | 'lock' | 'wipe' | 'assign' | 'unassign';
export type Occurs = number | 'unbounded';

export interface ActionOperationInfo {
  verb: ActionVerbPrefix;
  object: string | null;
}

export interface ChoiceSchema {
  minOccurs: number;
  maxOccurs: Occurs;
  options: string[][];
}

export interface SequenceSchema {
  minOccurs: number;
  maxOccurs: Occurs;
  fields: string[];
}

export interface AttributeSchema {
  type: string;
  required?: true;
  typeName?: string;
  enum?: string[];
  enumType?: string;
}

export interface FieldSchema {
  type: string;
  minOccurs: number;
  maxOccurs: Occurs;
  nillable: boolean;
  required?: true;
  default?: string;
  typeName?: string;
  enum?: string[];
  enumType?: string;
  fields?: Record<string, FieldSchema>;
  choices?: ChoiceSchema[];
  sequences?: SequenceSchema[];
  attributes?: Record<string, AttributeSchema>;
  items?: FieldSchema;
  choice?: number | number[];
  sequence?: number | number[];
  opaque?: true;
  ref?: string;
}

export interface OperationMetadata {
  verb: string;
  /** Top-level AXL object, or an empty string for global/unclassified operations. */
  object: string;
  kind: 'crud' | 'action' | 'other';
}

export interface OperationSchema extends OperationMetadata {
  fields: Record<string, FieldSchema>;
  choices: ChoiceSchema[];
  sequences: SequenceSchema[];
  attributes: Record<string, AttributeSchema>;
}

export interface AxlVersionArtifacts {
  version: WsdlVersion;
  topLevelObjects: readonly string[];
  objectOperations: Record<string, Record<string, string>>;
  actionOperations: Record<string, ActionOperationInfo>;
  enums: Record<string, string[]>;
  operationMetadata: Record<string, OperationMetadata>;
  operationSchemaDigest: string;
  operationSchemas: Record<string, OperationSchema>;
}
`;

  const objectImports = renderVersionImports(versions, [
    'AXL_TOP_LEVEL_OBJECTS',
    'AXL_OBJECT_OPERATIONS',
    'AXL_ACTION_OPERATIONS',
  ]);
  const axlObjectsFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Latest source WSDL version: ${latestVersion}

import type { ActionOperationInfo } from './axl-generated-types';
import type { WsdlVersion } from './wsdl-support';
${objectImports}

export type { ActionVerbPrefix, CrudVerb } from './axl-generated-types';

export const AXL_OBJECTS_SOURCE_WSDL_VERSION = ${JSON.stringify(latestVersion)} as const;

export const AXL_TOP_LEVEL_OBJECTS_BY_VERSION = ${renderVersionMap(versions, 'AXL_TOP_LEVEL_OBJECTS')} as const;
export const AXL_TOP_LEVEL_OBJECTS = AXL_TOP_LEVEL_OBJECTS_${versionSymbolSuffix(latestVersion)};
export type AxlTopLevelObject = (typeof AXL_TOP_LEVEL_OBJECTS)[number];

/** CRUD and object-bound action discovery for each WSDL version. */
export const AXL_OBJECT_OPERATIONS_BY_VERSION: Record<WsdlVersion, Record<string, Record<string, string>>> = ${renderVersionMap(versions, 'AXL_OBJECT_OPERATIONS')};
export const AXL_OBJECT_OPERATIONS = AXL_OBJECT_OPERATIONS_${versionSymbolSuffix(latestVersion)};

/** Non-CRUD action discovery for each WSDL version. */
export const AXL_ACTION_OPERATIONS_BY_VERSION: Record<WsdlVersion, Record<string, ActionOperationInfo>> = ${renderVersionMap(versions, 'AXL_ACTION_OPERATIONS')};
export const AXL_ACTION_OPERATIONS = AXL_ACTION_OPERATIONS_${versionSymbolSuffix(latestVersion)};
`;

  const objectsJson = JSON.stringify(
    {
      version: latestVersion,
      objects: latest.objects,
      objectsByVersion: topLevelObjectsByVersion,
      sourceDigestsByVersion,
    },
    null,
    2
  );

  const schemaImports = renderVersionImports(versions, [
    'AXL_ENUMS',
    'AXL_OPERATION_METADATA',
    'AXL_OPERATION_SCHEMA_DIGEST',
    'AXL_OPERATION_SCHEMAS',
  ]);
  const operationSchemasFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Latest source WSDL version: ${latestVersion}
// ${versions.reduce((sum, version) => sum + artifactsByVersion[version]!.operations.length, 0)} operation schemas across ${versions.length} versions

import type { WsdlVersion } from './wsdl-support';
import type { OperationMetadata, OperationSchema } from './axl-generated-types';
${schemaImports}

export type { AttributeSchema, ChoiceSchema, FieldSchema, Occurs, OperationMetadata, OperationSchema, SequenceSchema } from './axl-generated-types';

export const AXL_SCHEMAS_SOURCE_VERSION = ${JSON.stringify(latestVersion)} as const;

export const AXL_ENUMS_BY_VERSION: Record<WsdlVersion, Record<string, string[]>> = ${renderVersionMap(versions, 'AXL_ENUMS')};
export const AXL_ENUMS = AXL_ENUMS_${versionSymbolSuffix(latestVersion)};

export const AXL_OPERATION_METADATA_BY_VERSION: Record<WsdlVersion, Record<string, OperationMetadata>> = ${renderVersionMap(versions, 'AXL_OPERATION_METADATA')};

export const AXL_OPERATION_SCHEMA_DIGESTS_BY_VERSION: Record<WsdlVersion, string> = ${renderVersionMap(versions, 'AXL_OPERATION_SCHEMA_DIGEST')};

export const AXL_OPERATION_SCHEMAS_BY_VERSION: Record<WsdlVersion, Record<string, OperationSchema>> = ${renderVersionMap(versions, 'AXL_OPERATION_SCHEMAS')};

/** Latest-version alias retained for the existing MCP discovery surface. */
export const AXL_OPERATION_SCHEMAS = AXL_OPERATION_SCHEMAS_${versionSymbolSuffix(latestVersion)};
`;

  const latestSuffix = versionSymbolSuffix(latestVersion);
  const latestFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Runtime-only latest-version exports for the existing MCP surface.

import {
  AXL_ACTION_OPERATIONS_${latestSuffix},
  AXL_ENUMS_${latestSuffix},
  AXL_OBJECT_OPERATIONS_${latestSuffix},
  AXL_OPERATION_METADATA_${latestSuffix},
  AXL_OPERATION_SCHEMAS_${latestSuffix},
  AXL_TOP_LEVEL_OBJECTS_${latestSuffix},
} from './versions/axl-version-${versionFileSlug(latestVersion)}';

export type { ActionVerbPrefix, AttributeSchema, ChoiceSchema, CrudVerb, FieldSchema, Occurs, OperationMetadata, OperationSchema, SequenceSchema } from './axl-generated-types';

export const AXL_OBJECTS_SOURCE_WSDL_VERSION = ${JSON.stringify(latestVersion)} as const;
export const AXL_SCHEMAS_SOURCE_VERSION = ${JSON.stringify(latestVersion)} as const;
export const AXL_TOP_LEVEL_OBJECTS = AXL_TOP_LEVEL_OBJECTS_${latestSuffix};
export type AxlTopLevelObject = (typeof AXL_TOP_LEVEL_OBJECTS)[number];
export const AXL_OBJECT_OPERATIONS = AXL_OBJECT_OPERATIONS_${latestSuffix};
export const AXL_ACTION_OPERATIONS = AXL_ACTION_OPERATIONS_${latestSuffix};
export const AXL_ENUMS = AXL_ENUMS_${latestSuffix};
export const AXL_OPERATION_METADATA = AXL_OPERATION_METADATA_${latestSuffix};
export const AXL_OPERATION_SCHEMAS = AXL_OPERATION_SCHEMAS_${latestSuffix};
`;

  const loaderFile = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.

import type { AxlVersionArtifacts } from './axl-generated-types';
import type { WsdlVersion } from './wsdl-support';

export const AXL_VERSION_LOADERS: Record<WsdlVersion, () => Promise<AxlVersionArtifacts>> = {
${versions
  .map(
    version =>
      `  ${JSON.stringify(version)}: () => import('./versions/axl-version-${versionFileSlug(version)}').then(module => module.AXL_VERSION_ARTIFACTS),`
  )
  .join('\n')}
};

export function loadAxlVersionArtifacts(version: WsdlVersion): Promise<AxlVersionArtifacts> {
  return AXL_VERSION_LOADERS[version]();
}
`;

  const versionFiles = versions.map(version => {
    const artifact = artifactsByVersion[version];
    if (!artifact) throw new Error(`Missing generated artifacts for ${version}`);
    const suffix = versionSymbolSuffix(version);
    const file = `/* eslint-disable */
// AUTO-GENERATED by scripts/generate-types.ts. Do not edit by hand.
// Source WSDL version: ${version}

import type { ActionOperationInfo, AxlVersionArtifacts, OperationMetadata, OperationSchema } from '../axl-generated-types';

export const AXL_VERSION_${suffix} = ${JSON.stringify(version)} as const;
export const AXL_TOP_LEVEL_OBJECTS_${suffix} = ${JSON.stringify(artifact.objects)} as const;
export const AXL_OBJECT_OPERATIONS_${suffix}: Record<string, Record<string, string>> = ${JSON.stringify(artifact.objectOperations, null, 2)};
export const AXL_ACTION_OPERATIONS_${suffix}: Record<string, ActionOperationInfo> = ${JSON.stringify(artifact.actionOperations, null, 2)};
export const AXL_ENUMS_${suffix}: Record<string, string[]> = ${JSON.stringify(artifact.largeEnums, null, 2)};
export const AXL_OPERATION_METADATA_${suffix}: Record<string, OperationMetadata> = ${JSON.stringify(artifact.operationMetadata, null, 2)};
export const AXL_OPERATION_SCHEMA_DIGEST_${suffix} = ${JSON.stringify(artifact.operationSchemaDigest)};
export const AXL_OPERATION_SCHEMAS_${suffix}: Record<string, OperationSchema> = ${JSON.stringify(artifact.operationSchemas, null, 2)};

export const AXL_VERSION_ARTIFACTS: AxlVersionArtifacts = {
  version: AXL_VERSION_${suffix},
  topLevelObjects: AXL_TOP_LEVEL_OBJECTS_${suffix},
  objectOperations: AXL_OBJECT_OPERATIONS_${suffix},
  actionOperations: AXL_ACTION_OPERATIONS_${suffix},
  enums: AXL_ENUMS_${suffix},
  operationMetadata: AXL_OPERATION_METADATA_${suffix},
  operationSchemaDigest: AXL_OPERATION_SCHEMA_DIGEST_${suffix},
  operationSchemas: AXL_OPERATION_SCHEMAS_${suffix},
};
`;
    return {
      path: path.join(OUT_VERSIONS_DIR, `axl-version-${versionFileSlug(version)}.ts`),
      file,
    };
  });

  await fs.rm(OUT_VERSIONS_DIR, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(path.dirname(OUT_WSDL_SUPPORT), { recursive: true }),
    fs.mkdir(path.dirname(OUT_AXL_OBJECTS), { recursive: true }),
    fs.mkdir(path.dirname(OUT_OBJECTS_JSON), { recursive: true }),
    fs.mkdir(path.dirname(OUT_OPERATION_SCHEMAS), { recursive: true }),
    fs.mkdir(OUT_VERSIONS_DIR, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(OUT_WSDL_SUPPORT, wsdlSupportFile, 'utf8'),
    fs.writeFile(OUT_GENERATED_TYPES, generatedTypesFile, 'utf8'),
    fs.writeFile(OUT_LATEST, latestFile, 'utf8'),
    fs.writeFile(OUT_AXL_OBJECTS, axlObjectsFile, 'utf8'),
    fs.writeFile(OUT_OBJECTS_JSON, `${objectsJson}\n`, 'utf8'),
    fs.writeFile(OUT_OPERATION_SCHEMAS, operationSchemasFile, 'utf8'),
    fs.writeFile(OUT_VERSION_LOADER, loaderFile, 'utf8'),
    ...versionFiles.map(({ path: outputPath, file }) => fs.writeFile(outputPath, file, 'utf8')),
  ]);

  for (const version of versions) {
    const artifact = artifactsByVersion[version];
    if (!artifact) throw new Error(`Missing generated artifacts for ${version}`);
    process.stdout.write(
      `${version}: ${artifact.operations.length} operations, ${artifact.objects.length} objects, ${artifact.enumCount} enums (${artifact.enumValueCount} values), ${artifact.typeCount} complex types\n`
    );
  }
}

main().catch(error => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
