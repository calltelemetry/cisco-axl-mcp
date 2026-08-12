import { z } from 'zod';
import { redactCredentials } from '../lib/audit-log';

export const CLI_SCHEMA_VERSION = 'cisco-axl.cli.v1' as const;
export type CliExitCode = 0 | 2 | 3 | 4 | 5;
export type CliFailureExitCode = Exclude<CliExitCode, 0>;

const CLI_META_SCHEMA = z.record(z.string(), z.unknown());
const CLI_ERROR_SCHEMA = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});

export const CLI_SUCCESS_ENVELOPE_SCHEMA = z
  .object({
    schema_version: z.literal(CLI_SCHEMA_VERSION),
    ok: z.literal(true),
    data: z.unknown(),
    meta: CLI_META_SCHEMA,
  })
  .strict();

export const CLI_FAILURE_ENVELOPE_SCHEMA = z
  .object({
    schema_version: z.literal(CLI_SCHEMA_VERSION),
    ok: z.literal(false),
    error: CLI_ERROR_SCHEMA,
    meta: CLI_META_SCHEMA.optional(),
  })
  .strict();

export type CliSuccessEnvelope = z.infer<typeof CLI_SUCCESS_ENVELOPE_SCHEMA>;
export type CliFailureEnvelope = z.infer<typeof CLI_FAILURE_ENVELOPE_SCHEMA>;

const UNSAFE_JSON_CODE_POINTS = /[\u007f-\u009f\u2028\u2029]/gu;

export function serializeCliEnvelope(envelope: CliSuccessEnvelope | CliFailureEnvelope): string {
  return JSON.stringify(envelope).replace(UNSAFE_JSON_CODE_POINTS, character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  });
}

export interface CliErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: CliFailureExitCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function successEnvelope(data: unknown, meta: Record<string, unknown>): CliSuccessEnvelope {
  return CLI_SUCCESS_ENVELOPE_SCHEMA.parse({
    schema_version: CLI_SCHEMA_VERSION,
    ok: true,
    data,
    meta,
  });
}

export function failureEnvelope(
  error: CliErrorBody,
  meta?: Record<string, unknown>
): CliFailureEnvelope {
  return CLI_FAILURE_ENVELOPE_SCHEMA.parse({
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    error,
    ...(meta !== undefined && { meta }),
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as Record<string, unknown>).message === 'string'
  ) {
    return (error as Record<string, unknown>).message as string;
  }
  return String(error);
}

function policyExitCode(code: string): CliFailureExitCode | undefined {
  if (code === 'AXL_UNSUPPORTED_VERSION' || code === 'AXL_UNSUPPORTED_OPERATION') return 3;
  if (
    code.startsWith('AXL_MUTATION_') ||
    code.startsWith('AXL_POLICY_') ||
    code === 'AXL_OPERATION_INVALID'
  ) {
    return 5;
  }
  return undefined;
}

export function toCliFailure(
  error: unknown,
  sensitiveValues: readonly string[] = [],
  meta?: Record<string, unknown>
): { exitCode: CliFailureExitCode; envelope: CliFailureEnvelope; diagnostic: string } {
  const redacted = redactCredentials(error, sensitiveValues);
  let body: CliErrorBody;
  let exitCode: CliFailureExitCode;

  if (error instanceof CliError) {
    exitCode = error.exitCode;
    const redactedDetails =
      error.details === undefined ? undefined : redactCredentials(error.details, sensitiveValues);
    body = {
      code: error.code,
      message: errorMessage(redactCredentials(error.message, sensitiveValues)),
      ...(redactedDetails !== undefined && { details: redactedDetails }),
    };
  } else {
    const code =
      error !== null &&
      typeof error === 'object' &&
      typeof (error as Record<string, unknown>).code === 'string'
        ? ((error as Record<string, unknown>).code as string)
        : 'CLI_AXL_FAILURE';
    exitCode = policyExitCode(code) ?? 4;
    body = { code, message: errorMessage(redacted) };
  }

  const envelope = failureEnvelope(body, meta);
  return {
    exitCode,
    envelope,
    diagnostic: `${body.code}: ${body.message}`,
  };
}
