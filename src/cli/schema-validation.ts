import { z } from 'zod';
import type {
  ChoiceSchema,
  FieldSchema,
  Occurs,
  OperationSchema,
} from '../types/generated/axl-generated-types';
import { CliError } from './output';

export interface CliValidationDetail {
  path: string;
  kind: 'required' | 'type' | 'enum' | 'choice' | 'array' | 'unknown';
  message: string;
  expected?: string;
  enum?: string[];
  choice?: { minOccurs: number; maxOccurs: Occurs; options: string[][] };
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

function buildObjectSchema(
  fields: Record<string, FieldSchema>,
  choices: ChoiceSchema[],
  enums: Record<string, string[]>
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    shape[name] = buildFieldSchema(field, enums).optional();
  }

  return z.strictObject(shape).superRefine((value, context) => {
    for (const [name, field] of Object.entries(fields)) {
      if (field.required === true && !Object.prototype.hasOwnProperty.call(value, name)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Required field is missing',
          params: { kind: 'required', expected: field.type },
        });
      }
    }

    for (const choice of choices) {
      let selected = 0;
      let partial = false;
      for (const option of choice.options) {
        const present = option.filter(field => Object.prototype.hasOwnProperty.call(value, field));
        if (present.length === option.length && present.length > 0) selected++;
        else if (present.length > 0) partial = true;
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
  });
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
          ? buildObjectSchema(field.fields, field.choices ?? [], enums)
          : z.record(z.string(), z.unknown());
        break;
      case 'opaque':
        schema = z.unknown();
        break;
      default:
        schema = z.unknown();
    }
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
    field = fields[String(part)];
    if (!field) return undefined;
    if (field.type === 'array' && field.items?.fields) fields = field.items.fields;
    else if (field.fields) fields = field.fields;
  }
  return field;
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
  const schema = buildObjectSchema(operation.fields, operation.choices, enums);
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new CliSchemaValidationError(
      result.error.issues.map(issue => issueDetail(issue, operation, enums))
    );
  }
  return result.data;
}
