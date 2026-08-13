import { z } from 'zod';
import { CliError } from './output';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const SECRET_OPTION_PATTERN =
  /(?:password|passwd|secret|token|authorization|credential|api[-_]?key|private[-_]?key)/iu;

function optionName(token: string): string {
  const equals = token.indexOf('=');
  return equals === -1 ? token : token.slice(0, equals);
}

function rejectsWithoutToken(token: string): boolean {
  return (
    token.startsWith('--') && (token.includes('=') || SECRET_OPTION_PATTERN.test(optionName(token)))
  );
}

export function formatDiagnosticToken(value: string): string {
  let formatted = '';
  let count = 0;
  for (const character of value) {
    if (count >= 80) {
      formatted += '…';
      break;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      formatted += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else if (character === '\\' || character === '"') {
      formatted += `\\${character}`;
    } else {
      formatted += character;
    }
    count++;
  }
  return `"${formatted}"`;
}

const NON_EMPTY = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(value => !hasControlCharacters(value), 'Control characters are not allowed');
const EXACT_NON_EMPTY = z
  .string()
  .min(1)
  .max(256)
  .refine(value => value.trim().length > 0, 'Value cannot be only whitespace')
  .refine(value => !hasControlCharacters(value), 'Control characters are not allowed');
const COMMON_FIELDS = {
  version: NON_EMPTY.optional(),
  json: z.literal(true).optional(),
};
const TARGET_FIELDS = {
  ...COMMON_FIELDS,
  host: NON_EMPTY.optional(),
  insecure: z.literal(true).optional(),
};

const CLI_COMMAND_SCHEMA = z.discriminatedUnion('command', [
  z.object({ command: z.literal('versions'), json: z.literal(true).optional() }).strict(),
  z.object({ command: z.literal('objects'), ...COMMON_FIELDS }).strict(),
  z
    .object({ command: z.literal('operations'), ...COMMON_FIELDS, object: NON_EMPTY.optional() })
    .strict(),
  z.object({ command: z.literal('describe'), ...COMMON_FIELDS, operation: NON_EMPTY }).strict(),
  z
    .object({
      command: z.literal('execute'),
      ...TARGET_FIELDS,
      operation: NON_EMPTY,
      data: z.string().optional(),
      autoPage: z.literal(true).optional(),
      write: z.literal(true).optional(),
      confirm: EXACT_NON_EMPTY.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('sql'),
      ...TARGET_FIELDS,
      action: z.enum(['query', 'update']),
      file: NON_EMPTY.optional(),
      write: z.literal(true).optional(),
      confirm: EXACT_NON_EMPTY.optional(),
    })
    .strict(),
]);

export type CliCommand = z.infer<typeof CLI_COMMAND_SCHEMA>;

const VALUE_FLAGS: Record<string, string> = {
  '--version': 'version',
  '--host': 'host',
  '--object': 'object',
  '--data': 'data',
  '--file': 'file',
  '--confirm': 'confirm',
};
const BOOLEAN_FLAGS: Record<string, string> = {
  '--json': 'json',
  '--insecure': 'insecure',
  '--auto-page': 'autoPage',
  '--write': 'write',
};

const ALLOWED_FIELDS: Record<CliCommand['command'], ReadonlySet<string>> = {
  versions: new Set(['json']),
  objects: new Set(['version', 'json']),
  operations: new Set(['version', 'json', 'object']),
  describe: new Set(['version', 'json']),
  execute: new Set(['version', 'json', 'host', 'insecure', 'data', 'autoPage', 'write', 'confirm']),
  sql: new Set(['version', 'json', 'host', 'insecure', 'file', 'write', 'confirm']),
};

function usage(message: string, details?: unknown): never {
  throw new CliError('CLI_USAGE', message, 2, details);
}

function parseArguments(
  tokens: readonly string[],
  command: CliCommand['command']
): { flags: Record<string, unknown>; positionals: string[] } {
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];
  const allowed = ALLOWED_FIELDS[command];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const valueField = VALUE_FLAGS[token];
    const booleanField = BOOLEAN_FLAGS[token];
    const field = valueField ?? booleanField;
    if (!field || !allowed.has(field)) {
      if (rejectsWithoutToken(token)) {
        usage('Sensitive or value-bearing options are not accepted');
      }
      usage(`Unknown option ${formatDiagnosticToken(token)} for ${formatDiagnosticToken(command)}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, field))
      usage(`Option ${formatDiagnosticToken(token)} was provided twice`);

    if (valueField) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--'))
        usage(`Option ${formatDiagnosticToken(token)} requires a value`);
      flags[field] = value;
      index++;
    } else {
      flags[field] = true;
    }
  }
  return { flags, positionals };
}

export function parseCliCommand(argv: readonly string[]): CliCommand {
  const [commandToken, ...rest] = argv;
  if (!commandToken) usage('A command is required');
  if (!['versions', 'objects', 'operations', 'describe', 'execute', 'sql'].includes(commandToken)) {
    if (rejectsWithoutToken(commandToken)) {
      usage('Sensitive or value-bearing options are not accepted');
    }
    usage(`Unknown command ${formatDiagnosticToken(commandToken)}`);
  }
  const command = commandToken as CliCommand['command'];
  const { flags, positionals } = parseArguments(rest, command);

  let raw: Record<string, unknown>;
  if (command === 'versions' || command === 'objects' || command === 'operations') {
    if (positionals.length > 0) usage(`${command} does not accept positional arguments`);
    raw = { command, ...flags };
  } else if (command === 'describe' || command === 'execute') {
    if (positionals.length !== 1) usage(`${command} requires exactly one operation name`);
    raw = { command, operation: positionals[0], ...flags };
  } else {
    const action = positionals[0];
    if (positionals.length !== 1 || action === undefined || !['query', 'update'].includes(action)) {
      usage('sql requires exactly one action: query or update');
    }
    raw = { command, action, ...flags };
  }

  const parsed = CLI_COMMAND_SCHEMA.safeParse(raw);
  if (!parsed.success) usage('Command arguments are invalid', parsed.error.issues);
  return parsed.data;
}
