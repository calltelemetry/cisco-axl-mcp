import { describe, expect, it } from 'vitest';
import { parseCliCommand } from '../src/cli/command';
import {
  CLI_MAX_PAYLOAD_BYTES,
  readBoundedStream,
  readJsonPayload,
  readSqlPayload,
} from '../src/cli/input';

describe('parseCliCommand', () => {
  it.each([
    [['versions'], { command: 'versions' }],
    [['objects', '--version', '11.5'], { command: 'objects', version: '11.5' }],
    [
      ['operations', '--object', 'CallManager', '--version', '15.0'],
      { command: 'operations', object: 'CallManager', version: '15.0' },
    ],
    [
      ['describe', 'listCallManager', '--version', '14.0'],
      { command: 'describe', operation: 'listCallManager', version: '14.0' },
    ],
    [
      ['execute', 'futureDynamicOperation', '--data', '{}', '--auto-page', '--json'],
      {
        command: 'execute',
        operation: 'futureDynamicOperation',
        data: '{}',
        autoPage: true,
        json: true,
      },
    ],
    [
      ['sql', 'query', '--file', 'query.sql', '--version', '12.5'],
      { command: 'sql', action: 'query', file: 'query.sql', version: '12.5' },
    ],
    [
      ['sql', 'update', '--file', 'update.sql', '--write', '--confirm', 'sql-update'],
      {
        command: 'sql',
        action: 'update',
        file: 'update.sql',
        write: true,
        confirm: 'sql-update',
      },
    ],
  ])('parses the stable command surface without per-operation subcommands', (argv, expected) => {
    expect(parseCliCommand(argv as string[])).toEqual(expected);
  });

  it('parses non-secret target and TLS overrides', () => {
    expect(
      parseCliCommand([
        'execute',
        'getPhone',
        '--host',
        'cucm.example.test',
        '--version',
        '15.0',
        '--insecure',
      ])
    ).toMatchObject({
      command: 'execute',
      operation: 'getPhone',
      host: 'cucm.example.test',
      version: '15.0',
      insecure: true,
    });
  });

  it('accepts options before positional operation and SQL action arguments', () => {
    expect(parseCliCommand(['execute', '--version', '15.0', 'getPhone'])).toMatchObject({
      command: 'execute',
      operation: 'getPhone',
      version: '15.0',
    });
    expect(parseCliCommand(['sql', '--version', '15.0', 'query'])).toMatchObject({
      command: 'sql',
      action: 'query',
      version: '15.0',
    });
  });

  it.each([
    ['execute', 'getPhone', '--password', 'do-not-accept'],
    ['execute', 'getPhone', '--data', '{}', '--data', '{}'],
    ['describe', 'getPhone\nforged-diagnostic', '--version', '15.0'],
    ['objects', '--unknown'],
  ])('rejects unknown, secret, and duplicate flags', (...argv) => {
    expect(() => parseCliCommand(argv)).toThrow();
  });
});

describe('readJsonPayload', () => {
  it('parses inline JSON as unknown input', async () => {
    await expect(
      readJsonPayload({ data: '{"name":"SEP001"}', readStdin: async () => '' })
    ).resolves.toEqual({ name: 'SEP001' });
  });

  it('loads @file JSON', async () => {
    await expect(
      readJsonPayload({
        data: '@request.json',
        readStdin: async () => '',
        readFile: async path => {
          expect(path).toBe('request.json');
          return Buffer.from('{"name":"SEP002"}');
        },
      })
    ).resolves.toEqual({ name: 'SEP002' });
  });

  it('uses stdin only when no explicit source is present', async () => {
    await expect(readJsonPayload({ readStdin: async () => '{"name":"SEP003"}' })).resolves.toEqual({
      name: 'SEP003',
    });
  });

  it.each(['{}', '@request.json'])(
    'rejects explicit input plus non-empty stdin: %s',
    async data => {
      await expect(
        readJsonPayload({
          data,
          readStdin: async () => '{"conflict":true}',
          readFile: async () => Buffer.from('{}'),
        })
      ).rejects.toMatchObject({ code: 'CLI_INPUT_CONFLICT', exitCode: 2 });
    }
  );

  it('reports an explicit/stdin conflict before classifying oversized injected stdin', async () => {
    await expect(
      readJsonPayload({
        data: '{}',
        readStdin: async () => 'x'.repeat(CLI_MAX_PAYLOAD_BYTES + 1),
      })
    ).rejects.toMatchObject({ code: 'CLI_INPUT_CONFLICT', exitCode: 2 });
  });

  it.each([
    ['inline', { data: `"${'x'.repeat(CLI_MAX_PAYLOAD_BYTES)}"` }],
    [
      'file',
      { data: '@large.json', readFile: async () => Buffer.alloc(CLI_MAX_PAYLOAD_BYTES + 1) },
    ],
    ['stdin', { readStdin: async () => 'x'.repeat(CLI_MAX_PAYLOAD_BYTES + 1) }],
  ])('rejects oversized %s input before JSON validation', async (_label, options) => {
    await expect(
      readJsonPayload({
        readStdin: async () => '',
        ...options,
      })
    ).rejects.toMatchObject({ code: 'CLI_PAYLOAD_TOO_LARGE', exitCode: 2 });
  });

  it('reports malformed JSON without echoing the payload', async () => {
    const secret = 'payload-secret-that-must-not-be-echoed';
    let thrown: unknown;
    try {
      await readJsonPayload({ data: `{"password":"${secret}"`, readStdin: async () => '' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'CLI_JSON_INVALID', exitCode: 2 });
    expect(String(thrown)).not.toContain(secret);
  });
});

describe('readBoundedStream', () => {
  it('stops consuming stdin as soon as the byte bound is exceeded', async () => {
    let yielded = 0;
    async function* chunks() {
      yielded++;
      yield Buffer.alloc(CLI_MAX_PAYLOAD_BYTES);
      yielded++;
      yield Buffer.from('x');
      yielded++;
      yield Buffer.from('must-not-be-read');
    }

    await expect(readBoundedStream(chunks())).rejects.toMatchObject({
      code: 'CLI_PAYLOAD_TOO_LARGE',
      exitCode: 2,
    });
    expect(yielded).toBe(2);
  });
});

describe('readSqlPayload', () => {
  it('loads SQL files without requiring JSON shell quoting', async () => {
    await expect(
      readSqlPayload({
        file: 'query.sql',
        readStdin: async () => '',
        readFile: async () => Buffer.from('select name from device'),
      })
    ).resolves.toBe('select name from device');
  });

  it('rejects a SQL file combined with stdin', async () => {
    await expect(
      readSqlPayload({
        file: 'query.sql',
        readStdin: async () => 'select * from numplan',
        readFile: async () => Buffer.from('select * from device'),
      })
    ).rejects.toMatchObject({ code: 'CLI_INPUT_CONFLICT', exitCode: 2 });
  });
});
