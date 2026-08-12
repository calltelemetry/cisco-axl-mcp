import { readFile as defaultReadFile } from 'node:fs/promises';
import { parseCliCommand, type CliCommand } from './cli/command';
import { readBoundedStream, readJsonPayload, readSqlPayload } from './cli/input';
import { CliError, successEnvelope, toCliFailure, type CliExitCode } from './cli/output';
import { validateOperationInput } from './cli/schema-validation';
import {
  AXL_RUNNER_PACKAGE_VERSION,
  runAxl as defaultRunAxl,
  type RunAxlDependencies,
  type RunAxlOptions,
} from './lib/axl-runner';
import { CredentialResolutionError, resolveCredentials } from './lib/credential-resolver';
import { createMutationGrant, isMutationOperation } from './lib/mutation-grants';
import { isSupportedCucmVersion } from './lib/version-manager';
import { loadAxlVersionArtifacts } from './types/generated/axl-version-loader';
import { WSDL_VERSIONS, type WsdlVersion } from './types/generated/wsdl-support';
import type { AxlVersionArtifacts } from './types/generated/axl-generated-types';

interface CliWritable {
  write(value: string): unknown;
}

export interface CliDependencies {
  env?: NodeJS.ProcessEnv;
  stdout?: CliWritable;
  stderr?: CliWritable;
  readStdin?: () => Promise<string | Buffer>;
  readFile?: (path: string) => Promise<string | Buffer>;
  runAxl?: (options: RunAxlOptions, dependencies?: RunAxlDependencies) => Promise<unknown>;
  now?: () => number;
  packageVersion?: string;
  runnerDependencies?: RunAxlDependencies;
}

async function readProcessStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  return readBoundedStream(process.stdin);
}

function selectedVersion(command: CliCommand, env: NodeJS.ProcessEnv): WsdlVersion {
  const version = 'version' in command ? (command.version ?? env.CUCM_VERSION) : env.CUCM_VERSION;
  if (!version) throw new CliError('CLI_VERSION_REQUIRED', 'A CUCM version is required', 2);
  if (!isSupportedCucmVersion(version)) {
    throw new CliError('CLI_UNSUPPORTED_VERSION', `CUCM version "${version}" is not supported`, 3, {
      supported_versions: WSDL_VERSIONS,
    });
  }
  return version;
}

async function versionArtifacts(
  command: CliCommand,
  env: NodeJS.ProcessEnv
): Promise<AxlVersionArtifacts> {
  return loadAxlVersionArtifacts(selectedVersion(command, env));
}

function operationSchema(artifacts: AxlVersionArtifacts, operation: string) {
  const metadata = artifacts.operationMetadata[operation];
  const schema = artifacts.operationSchemas[operation];
  if (!metadata || !schema) {
    throw new CliError(
      'CLI_UNSUPPORTED_OPERATION',
      `Operation "${operation}" is not available for CUCM ${artifacts.version}`,
      3,
      { operation, cucm_version: artifacts.version }
    );
  }
  return { metadata, schema };
}

function cliCredentials(
  command: Extract<CliCommand, { command: 'execute' | 'sql' }>,
  env: NodeJS.ProcessEnv
) {
  try {
    return resolveCredentials(
      {
        cucm_host: command.host,
        cucm_version: command.version,
      },
      env
    );
  } catch (error) {
    if (error instanceof CredentialResolutionError) {
      if (error.kind === 'missing') {
        throw new CliError('CLI_CREDENTIALS_MISSING', error.message, 2);
      }
      throw new CliError('CLI_UNSUPPORTED_VERSION', error.message, 3);
    }
    throw error;
  }
}

function requireMutationConfirmation(
  command: { write?: true; confirm?: string },
  confirmation: string
): void {
  if (command.write !== true) {
    throw new CliError('CLI_MUTATION_WRITE_REQUIRED', 'Mutating operations require --write', 5);
  }
  if (command.confirm !== confirmation) {
    throw new CliError(
      'CLI_MUTATION_CONFIRMATION_INVALID',
      `Mutating operation confirmation must exactly match "${confirmation}"`,
      5
    );
  }
}

function rejectReadOnlyMutationFlags(command: { write?: true; confirm?: string }): void {
  if (command.write === true || command.confirm !== undefined) {
    throw new CliError(
      'CLI_MUTATION_FLAGS_NOT_ALLOWED',
      'Read-only operations do not accept mutation flags',
      5
    );
  }
}

async function executeOperation(options: {
  command: Extract<CliCommand, { command: 'execute' | 'sql' }>;
  artifacts: AxlVersionArtifacts;
  operation: string;
  data: unknown;
  expectedConfirmation: string;
  env: NodeJS.ProcessEnv;
  runAxl: NonNullable<CliDependencies['runAxl']>;
  now: () => number;
  packageVersion: string;
  runnerDependencies?: RunAxlDependencies;
}): Promise<unknown> {
  const { metadata, schema } = operationSchema(options.artifacts, options.operation);
  const data = validateOperationInput(schema, options.artifacts.enums, options.data);
  if (
    'autoPage' in options.command &&
    options.command.autoPage === true &&
    metadata.verb !== 'list'
  ) {
    throw new CliError(
      'CLI_AUTOPAGE_INVALID',
      `Auto-pagination is only available for list operations, got "${options.operation}"`,
      2
    );
  }
  const credentials = cliCredentials(options.command, options.env);
  const tlsMode = options.command.insecure === true ? 'insecure' : 'secure';
  const request = {
    credentials,
    tlsMode,
    operation: options.operation,
    data,
    ...('autoPage' in options.command && options.command.autoPage === true && { autoPage: true }),
  } as const;
  const mutation = isMutationOperation(options.operation, metadata);
  let mutationGrant;
  if (mutation) {
    requireMutationConfirmation(options.command, options.expectedConfirmation);
    const now = options.now();
    mutationGrant = await createMutationGrant(
      {
        request,
        packageVersion: options.packageVersion,
        expiresAt: new Date(now + 5 * 60_000).toISOString(),
      },
      { now: () => now, authority: options.runnerDependencies?.grantAuthority }
    );
  } else {
    rejectReadOnlyMutationFlags(options.command);
  }

  return options.runAxl(
    {
      request,
      source: 'cli',
      validationMode: 'strict',
      ...(mutationGrant !== undefined && { mutationGrant }),
    },
    {
      ...options.runnerDependencies,
      packageVersion: options.packageVersion,
      now: options.now,
    }
  );
}

function outputMeta(command: CliCommand): Record<string, unknown> {
  const meta: Record<string, unknown> = { command: command.command };
  if ('operation' in command) meta.operation = command.operation;
  return meta;
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {}
): Promise<CliExitCode> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const readStdin = dependencies.readStdin ?? readProcessStdin;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const runner = dependencies.runAxl ?? defaultRunAxl;
  const now = dependencies.now ?? Date.now;
  const packageVersion = dependencies.packageVersion ?? AXL_RUNNER_PACKAGE_VERSION;
  let meta: Record<string, unknown> | undefined;

  try {
    const command = parseCliCommand(argv);
    meta = outputMeta(command);
    let data: unknown;

    if (command.command === 'versions') {
      data = { versions: [...WSDL_VERSIONS] };
    } else {
      const artifacts = await versionArtifacts(command, env);
      meta.cucm_version = artifacts.version;

      if (command.command === 'objects') {
        data = { objects: [...artifacts.topLevelObjects] };
      } else if (command.command === 'operations') {
        if (command.object !== undefined) {
          const objectOperations = artifacts.objectOperations[command.object];
          if (!objectOperations) {
            throw new CliError(
              'CLI_UNSUPPORTED_OBJECT',
              `Object "${command.object}" is not available for CUCM ${artifacts.version}`,
              3,
              { object: command.object, cucm_version: artifacts.version }
            );
          }
          data = {
            operations: Object.entries(objectOperations)
              .map(([verb, operation]) => ({ verb, operation }))
              .sort((left, right) => left.operation.localeCompare(right.operation)),
          };
        } else {
          data = {
            operations: Object.entries(artifacts.operationMetadata)
              .map(([operation, operationMeta]) => ({ operation, ...operationMeta }))
              .sort((left, right) => left.operation.localeCompare(right.operation)),
          };
        }
      } else if (command.command === 'describe') {
        const { schema } = operationSchema(artifacts, command.operation);
        meta.operation = command.operation;
        data = schema;
      } else if (command.command === 'execute') {
        meta.operation = command.operation;
        meta.tls_mode = command.insecure === true ? 'insecure' : 'secure';
        if (command.insecure === true) {
          stderr.write('WARNING: TLS certificate verification is disabled for this call.\n');
        }
        const payload = await readJsonPayload({ data: command.data, readStdin, readFile });
        data = await executeOperation({
          command,
          artifacts,
          operation: command.operation,
          data: payload,
          expectedConfirmation: command.operation,
          env,
          runAxl: runner,
          now,
          packageVersion,
          runnerDependencies: dependencies.runnerDependencies,
        });
      } else {
        const operation = command.action === 'query' ? 'executeSQLQuery' : 'executeSQLUpdate';
        meta.operation = operation;
        meta.tls_mode = command.insecure === true ? 'insecure' : 'secure';
        if (command.insecure === true) {
          stderr.write('WARNING: TLS certificate verification is disabled for this call.\n');
        }
        const sql = await readSqlPayload({ file: command.file, readStdin, readFile });
        data = await executeOperation({
          command,
          artifacts,
          operation,
          data: { sql },
          expectedConfirmation: 'sql-update',
          env,
          runAxl: runner,
          now,
          packageVersion,
          runnerDependencies: dependencies.runnerDependencies,
        });
      }
    }

    stdout.write(`${JSON.stringify(successEnvelope(data, meta))}\n`);
    return 0;
  } catch (error) {
    const sensitiveValues = [env.CUCM_PASSWORD, env.CUCM_USERNAME].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    const failure = toCliFailure(error, sensitiveValues, meta);
    stdout.write(`${JSON.stringify(failure.envelope)}\n`);
    stderr.write(`${failure.diagnostic}\n`);
    return failure.exitCode;
  }
}
