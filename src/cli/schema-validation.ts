import { z } from 'zod';
import type {
  AttributeSchema,
  ChoiceSchema,
  FieldSchema,
  Occurs,
  OperationSchema,
  SequenceSchema,
} from '../types/generated/axl-generated-types';
import { CliError } from './output';

export interface CliValidationDetail {
  path: string;
  kind: 'required' | 'type' | 'enum' | 'choice' | 'sequence' | 'attribute' | 'array' | 'unknown';
  message: string;
  expected?: string;
  enum?: string[];
  choice?: { minOccurs: number; maxOccurs: Occurs; options: string[][] };
  sequence?: { minOccurs: number; maxOccurs: Occurs; fields: string[]; missing: string[] };
  array?: { minItems: number; maxItems: Occurs };
  keys?: string[];
}

export class CliSchemaValidationError extends CliError {
  constructor(public override readonly details: CliValidationDetail[]) {
    super('CLI_SCHEMA_INVALID', 'Payload validation failed', 2, details);
    this.name = 'CliSchemaValidationError';
  }
}

function allowedEnum(field: FieldSchema, enums: Record<string, string[]>): string[] | undefined {
  return field.enum ?? (field.enumType ? enums[field.enumType] : undefined);
}

function allowedAttributeEnum(
  attribute: AttributeSchema,
  enums: Record<string, string[]>
): string[] | undefined {
  return attribute.enum ?? (attribute.enumType ? enums[attribute.enumType] : undefined);
}

function choiceIssue(choice: ChoiceSchema): Record<string, unknown> {
  return {
    kind: 'choice',
    choice: {
      minOccurs: choice.minOccurs,
      maxOccurs: choice.maxOccurs,
      options: choice.options,
    },
  };
}

function hasOwn(value: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name);
}

function belongsToChoice(name: string, choices: ChoiceSchema[]): boolean {
  return choices.some(choice => choice.options.some(option => option.includes(name)));
}

function belongsToSequence(name: string, sequences: SequenceSchema[]): boolean {
  return sequences.some(sequence => sequence.fields.includes(name));
}

function memberships(value: number | number[] | undefined): number[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function shouldEvaluateChoice(
  choiceIndex: number,
  choice: ChoiceSchema,
  fields: Record<string, FieldSchema>,
  sequences: SequenceSchema[],
  value: Record<string, unknown>
): boolean {
  const optionFields = [...new Set(choice.options.flat())];
  const markedFields = Object.entries(fields)
    .filter(([, field]) => memberships(field.choice).includes(choiceIndex))
    .map(([name]) => name);
  const contextFields = markedFields.length > 0 ? markedFields : optionFields;
  if (contextFields.some(name => memberships(fields[name]?.sequence).length === 0)) return true;

  const parentSequences = [
    ...new Set(contextFields.flatMap(name => memberships(fields[name]?.sequence))),
  ];
  return parentSequences.some(sequenceIndex => {
    const sequence = sequences[sequenceIndex];
    return (
      sequence !== undefined &&
      (sequence.minOccurs >= 1 || sequence.fields.some(field => hasOwn(value, field)))
    );
  });
}

function buildAttributeValueSchema(
  attribute: AttributeSchema,
  enums: Record<string, string[]>
): z.ZodType {
  const values = allowedAttributeEnum(attribute, enums);
  if (values && values.length > 0) return z.enum(values as [string, ...string[]]);
  if (attribute.type === 'integer') return z.number().int();
  if (attribute.type === 'boolean') return z.boolean();
  return z.string();
}

function buildAttributesSchema(
  attributes: Record<string, AttributeSchema>,
  enums: Record<string, string[]>
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    shape[name] = buildAttributeValueSchema(attribute, enums).optional();
  }
  return z.strictObject(shape).superRefine((value, context) => {
    for (const [name, attribute] of Object.entries(attributes)) {
      if (attribute.required === true && !hasOwn(value, name)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required attribute is missing',
          params: { kind: 'attribute', expected: attribute.type },
        });
      }
    }
  });
}

function addRequiredAttributeIssues(
  value: Record<string, unknown>,
  context: z.RefinementCtx,
  attributes: Record<string, AttributeSchema>
): void {
  if (hasOwn(value, 'attributes')) return;
  for (const [name, attribute] of Object.entries(attributes)) {
    if (attribute.required === true) {
      context.addIssue({
        code: 'custom',
        path: ['attributes', name],
        message: 'Required attribute is missing',
        params: { kind: 'attribute', expected: attribute.type },
      });
    }
  }
}

function buildObjectSchema(
  fields: Record<string, FieldSchema>,
  choices: ChoiceSchema[],
  sequences: SequenceSchema[],
  attributes: Record<string, AttributeSchema>,
  enums: Record<string, string[]>
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = buildFieldSchema(field, enums).optional();
  }
  if (Object.keys(attributes).length > 0) {
    shape.attributes = buildAttributesSchema(attributes, enums).optional();
  }

  return z.strictObject(shape).superRefine((value, context) => {
    for (const [name, field] of Object.entries(fields)) {
      const occurrenceRequired = field.required === true || field.minOccurs >= 1;
      if (
        occurrenceRequired &&
        !belongsToChoice(name, choices) &&
        !belongsToSequence(name, sequences) &&
        !hasOwn(value, name)
      ) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required field is missing',
          params: { kind: 'required', expected: field.type },
        });
      }
    }

    for (const [choiceIndex, choice] of choices.entries()) {
      if (!shouldEvaluateChoice(choiceIndex, choice, fields, sequences, value)) continue;
      let selected = 0;
      let partial = false;
      for (const option of choice.options) {
        const present = option.filter(field => hasOwn(value, field));
        if (present.length === 0) continue;
        const missingRequired = option.filter(
          field => (fields[field]?.minOccurs ?? 0) >= 1 && !hasOwn(value, field)
        );
        if (missingRequired.length === 0) selected++;
        else partial = true;
      }
      const maximum =
        choice.maxOccurs === 'unbounded' ? Number.POSITIVE_INFINITY : choice.maxOccurs;
      if (partial || selected < choice.minOccurs || selected > maximum) {
        context.addIssue({
          code: 'custom',
          message: 'Payload does not satisfy the generated XSD choice',
          params: choiceIssue(choice),
        });
      }
    }

    for (const sequence of sequences) {
      const present = sequence.fields.filter(field => hasOwn(value, field));
      const requiredMembers = sequence.fields.filter(field => {
        const schema = fields[field];
        return schema !== undefined && schema.minOccurs >= 1 && !belongsToChoice(field, choices);
      });
      const selected = present.length > 0;
      const missing = requiredMembers.filter(field => !hasOwn(value, field));
      if ((sequence.minOccurs >= 1 && !selected) || (selected && missing.length > 0)) {
        context.addIssue({
          code: 'custom',
          message: 'Payload does not satisfy the generated XSD sequence',
          params: {
            kind: 'sequence',
            sequence: {
              minOccurs: sequence.minOccurs,
              maxOccurs: sequence.maxOccurs,
              fields: sequence.fields,
              missing,
            },
          },
        });
      }
    }

    addRequiredAttributeIssues(value, context, attributes);
  });
}

function withSimpleContentAttributes(
  valueSchema: z.ZodType,
  attributes: Record<string, AttributeSchema>,
  enums: Record<string, string[]>
): z.ZodType {
  const attributeSchema = buildAttributesSchema(attributes, enums);
  const wrapped = z
    .strictObject({
      value: valueSchema,
      attributes: attributeSchema.optional(),
    })
    .superRefine((value, context) => addRequiredAttributeIssues(value, context, attributes));
  const hasRequiredAttribute = Object.values(attributes).some(
    attribute => attribute.required === true
  );
  return hasRequiredAttribute ? wrapped : z.union([valueSchema, wrapped]);
}

function buildFieldSchema(field: FieldSchema, enums: Record<string, string[]>): z.ZodType {
  let schema: z.ZodType;
  const values = allowedEnum(field, enums);

  if (values && values.length > 0) {
    schema = z.enum(values as [string, ...string[]]);
  } else {
    switch (field.type) {
      case 'string':
        schema = z.string();
        break;
      case 'integer':
        schema = z.number().int();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array': {
        const itemSchema = field.items ? buildFieldSchema(field.items, enums) : z.unknown();
        let arraySchema = z.array(itemSchema).min(field.minOccurs);
        if (field.maxOccurs !== 'unbounded') arraySchema = arraySchema.max(field.maxOccurs);
        schema = arraySchema;
        break;
      }
      case 'object':
        schema = field.fields
          ? buildObjectSchema(
              field.fields,
              field.choices ?? [],
              field.sequences ?? [],
              field.attributes ?? {},
              enums
            )
          : z.record(z.string(), z.unknown());
        break;
      case 'opaque':
        schema = z.unknown().refine(value => value !== null, 'Expected a non-null opaque value');
        break;
      default:
        schema = z.unknown();
    }
  }

  if (
    field.type !== 'object' &&
    field.type !== 'array' &&
    field.attributes &&
    Object.keys(field.attributes).length > 0
  ) {
    schema = withSimpleContentAttributes(schema, field.attributes, enums);
  }

  return field.nillable ? schema.nullable() : schema;
}

function pathString(path: PropertyKey[]): string {
  if (path.length === 0) return '$';
  let result = '';
  for (const part of path) {
    if (typeof part === 'number') result += `[${part}]`;
    else result += result ? `.${String(part)}` : String(part);
  }
  return result;
}

function fieldAtPath(schema: OperationSchema, path: PropertyKey[]): FieldSchema | undefined {
  let fields = schema.fields;
  let field: FieldSchema | undefined;
  for (const part of path) {
    if (typeof part === 'number') {
      field = field?.items;
      if (field?.fields) fields = field.fields;
      continue;
    }
    if (part === 'value' || part === 'attributes') continue;
    field = fields[String(part)];
    if (!field) return undefined;
    if (field.type === 'array' && field.items?.fields) fields = field.items.fields;
    else if (field.fields) fields = field.fields;
  }
  return field;
}

function attributeAtPath(
  operation: OperationSchema,
  path: PropertyKey[]
): AttributeSchema | undefined {
  let attributes = operation.attributes;
  let fields = operation.fields;
  let field: FieldSchema | undefined;
  for (let index = 0; index < path.length; index++) {
    const part = path[index];
    if (part === 'attributes') {
      const name = path[index + 1];
      return typeof name === 'string' ? attributes[name] : undefined;
    }
    if (part === 'value' || typeof part === 'number') continue;
    field = fields[String(part)];
    if (!field) return undefined;
    attributes = field.attributes ?? {};
    if (field.type === 'array' && field.items?.fields) fields = field.items.fields;
    else if (field.fields) fields = field.fields;
  }
  return undefined;
}

function issueDetail(
  issue: z.core.$ZodIssue,
  operation: OperationSchema,
  enums: Record<string, string[]>
): CliValidationDetail {
  const params =
    'params' in issue && issue.params && typeof issue.params === 'object'
      ? (issue.params as Record<string, unknown>)
      : undefined;
  const field = fieldAtPath(operation, issue.path);
  const values = field ? allowedEnum(field, enums) : undefined;

  if (params?.kind === 'choice') {
    return {
      path: pathString(issue.path),
      kind: 'choice',
      message: issue.message,
      choice: params.choice as CliValidationDetail['choice'],
    };
  }
  if (params?.kind === 'sequence') {
    return {
      path: pathString(issue.path),
      kind: 'sequence',
      message: issue.message,
      sequence: params.sequence as CliValidationDetail['sequence'],
    };
  }
  if (params?.kind === 'attribute') {
    return {
      path: pathString(issue.path),
      kind: 'attribute',
      message: issue.message,
      expected: String(params.expected),
    };
  }
  if (params?.kind === 'required') {
    return {
      path: pathString(issue.path),
      kind: 'required',
      message: issue.message,
      expected: String(params.expected),
    };
  }
  if (issue.code === 'unrecognized_keys') {
    return {
      path: pathString(issue.path),
      kind: 'unknown',
      message: issue.message,
      keys: issue.keys,
    };
  }
  const attribute = attributeAtPath(operation, issue.path);
  if (attribute) {
    return {
      path: pathString(issue.path),
      kind: 'attribute',
      message: issue.message,
      expected: attribute.type,
    };
  }
  if (values && values.length > 0) {
    return {
      path: pathString(issue.path),
      kind: 'enum',
      message: issue.message,
      enum: values,
    };
  }
  if (field?.type === 'array') {
    return {
      path: pathString(issue.path),
      kind: 'array',
      message: issue.message,
      array: { minItems: field.minOccurs, maxItems: field.maxOccurs },
    };
  }
  return {
    path: pathString(issue.path),
    kind: 'type',
    message: issue.message,
    ...(field?.type && { expected: field.type }),
  };
}

export function validateOperationInput(
  operation: OperationSchema,
  enums: Record<string, string[]>,
  input: unknown
): unknown {
  const schema = buildObjectSchema(
    operation.fields,
    operation.choices,
    operation.sequences,
    operation.attributes,
    enums
  );
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CliSchemaValidationError(
      result.error.issues.map(issue => issueDetail(issue, operation, enums))
    );
  }
  return result.data;
}
