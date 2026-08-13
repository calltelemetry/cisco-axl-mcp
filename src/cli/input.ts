import { readFile as defaultReadFile } from 'node:fs/promises';
import { CliError } from './output';
import { formatDiagnosticToken } from './command';

export const CLI_MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface ReadStdinOptions {
  explicitInput?: boolean;
  maxBytes?: number;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export async function readCliStdin(
  stream: AsyncIterable<unknown>,
  options: ReadStdinOptions = {}
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? CLI_MAX_PAYLOAD_BYTES;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : Buffer.from(String(chunk));
    if (options.explicitInput && buffer.some(byte => !isJsonWhitespace(byte))) {
      throw new CliError(
        'CLI_INPUT_CONFLICT',
        'Explicit input cannot be combined with non-empty stdin',
        2
      );
    }
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new CliError(
        'CLI_PAYLOAD_TOO_LARGE',
        `Input exceeds the ${maxBytes}-byte payload limit`,
        2,
        { max_bytes: maxBytes }
      );
    }
    if (!options.explicitInput) chunks.push(buffer);
  }
  return options.explicitInput ? Buffer.alloc(0) : Buffer.concat(chunks, totalBytes);
}

export async function readBoundedStream(
  stream: AsyncIterable<unknown>,
  maxBytes: number = CLI_MAX_PAYLOAD_BYTES
): Promise<Buffer> {
  return readCliStdin(stream, { maxBytes });
}

export interface PayloadInputOptions {
  readStdin: (options?: ReadStdinOptions) => Promise<string | Buffer>;
  readFile?: (path: string) => Promise<string | Buffer>;
  maxBytes?: number;
}

export interface JsonPayloadInputOptions extends PayloadInputOptions {
  data?: string;
}

export interface SqlPayloadInputOptions extends PayloadInputOptions {
  file?: string;
}

function bytes(value: string | Buffer): number {
  return Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value, 'utf8');
}

function bounded(value: string | Buffer, maxBytes: number): string {
  if (bytes(value) > maxBytes) {
    throw new CliError(
      'CLI_PAYLOAD_TOO_LARGE',
      `Input exceeds the ${maxBytes}-byte payload limit`,
      2,
      { max_bytes: maxBytes }
    );
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

async function explicitFile(
  path: string,
  readFile: (path: string) => Promise<string | Buffer>,
  maxBytes: number
): Promise<string> {
  if (!path) throw new CliError('CLI_INPUT_FILE_INVALID', 'An @file path is required', 2);
  try {
    return bounded(await readFile(path), maxBytes);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'CLI_INPUT_FILE_FAILED',
      `Unable to read input file ${formatDiagnosticToken(path)}`,
      2
    );
  }
}

async function readSources(options: {
  explicit?: string;
  explicitFile?: boolean;
  readStdin: (options?: ReadStdinOptions) => Promise<string | Buffer>;
  readFile: (path: string) => Promise<string | Buffer>;
  maxBytes: number;
}): Promise<string> {
  const stdinRaw = await options.readStdin({ explicitInput: options.explicit !== undefined });
  const stdinText = Buffer.isBuffer(stdinRaw) ? stdinRaw.toString('utf8') : stdinRaw;
  if (options.explicit !== undefined && stdinText.trim().length > 0) {
    throw new CliError(
      'CLI_INPUT_CONFLICT',
      'Explicit input cannot be combined with non-empty stdin',
      2
    );
  }
  const stdin = bounded(stdinRaw, options.maxBytes);
  if (options.explicit === undefined) return stdin;
  if (options.explicitFile) {
    return explicitFile(options.explicit, options.readFile, options.maxBytes);
  }
  return bounded(options.explicit, options.maxBytes);
}

export async function readJsonPayload(options: JsonPayloadInputOptions): Promise<unknown> {
  const maxBytes = options.maxBytes ?? CLI_MAX_PAYLOAD_BYTES;
  const data = options.data;
  const isFile = data?.startsWith('@') === true;
  const source = await readSources({
    explicit: isFile && data !== undefined ? data.slice(1) : data,
    explicitFile: isFile,
    readStdin: options.readStdin,
    readFile: options.readFile ?? defaultReadFile,
    maxBytes,
  });
  if (source.trim().length === 0) return {};
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new CliError('CLI_JSON_INVALID', 'Input is not valid JSON', 2);
  }
}

export async function readSqlPayload(options: SqlPayloadInputOptions): Promise<string> {
  const maxBytes = options.maxBytes ?? CLI_MAX_PAYLOAD_BYTES;
  const source = await readSources({
    explicit: options.file,
    explicitFile: options.file !== undefined,
    readStdin: options.readStdin,
    readFile: options.readFile ?? defaultReadFile,
    maxBytes,
  });
  if (source.trim().length === 0) {
    throw new CliError('CLI_SQL_EMPTY', 'SQL input must not be empty', 2);
  }
  return source;
}
