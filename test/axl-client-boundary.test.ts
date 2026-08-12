import { afterEach, describe, expect, it, vi } from 'vitest';
import CiscoAxlService from 'cisco-axl';
import { runCli } from '../src/cli';
import { getAxlClient } from '../src/lib/axl-client';

const servicePrototype = CiscoAxlService.prototype as unknown as {
  _getClient(): Promise<unknown>;
};
const originalGetClient = servicePrototype._getClient;
const originalDebug = process.env.DEBUG;

afterEach(() => {
  servicePrototype._getClient = originalGetClient;
  if (originalDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = originalDebug;
  vi.restoreAllMocks();
});

describe('real cisco-axl client logging boundary', () => {
  it('keeps dependency DEBUG credentials and request controls out of CLI output', async () => {
    const secret = 'REAL-CLIENT-SECRET-491';
    const controls = [
      ...Array.from({ length: 0x20 }, (_, codePoint) => String.fromCharCode(codePoint)),
      String.fromCharCode(0x7f),
      ...Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)),
      '\u2028',
      '\u2029',
    ].join('');
    const fakeSoapClient = {
      security: { addHttpHeaders: () => {}, addOptions: () => {} },
      setSecurity(security: unknown) {
        this.security = security as typeof this.security;
      },
      on: () => {},
      AXLAPIService: {
        AXLPort: {
          getPhone(
            _message: unknown,
            callback: (error: null, result: unknown, rawResponse: string) => void
          ) {
            callback(null, { return: { phone: { name: 'safe-result' } } }, '<safe />');
          },
        },
      },
    };
    servicePrototype._getClient = async () => fakeSoapClient;
    process.env.DEBUG = 'cisco-axl:*';
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    let stdout = '';
    let stderr = '';

    const exitCode = await runCli(
      ['execute', 'getPhone', '--data', JSON.stringify({ name: `${secret}${controls}` })],
      {
        env: {
          CUCM_HOST: 'real-client.example.test',
          CUCM_USERNAME: 'axl-user',
          CUCM_PASSWORD: secret,
          CUCM_VERSION: '15.0',
        },
        stdout: { write: value => ((stdout += String(value)), true) },
        stderr: { write: value => ((stderr += String(value)), true) },
        readStdin: async () => '',
        runAxl: options =>
          getAxlClient(options.request.credentials, options.request.tlsMode).executeOperation(
            options.request.operation,
            options.request.data,
            options.request.opts
          ),
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: 'cisco-axl.cli.v1',
      ok: true,
      data: { phone: { name: 'safe-result' } },
    });
    expect(stderr).toBe('');

    const allOutput = [
      stdout,
      stderr,
      consoleLog.mock.calls.flat().join(' '),
      consoleError.mock.calls.flat().join(' '),
    ];
    for (const output of allOutput) {
      expect(output).not.toContain(secret);
      for (const control of controls) {
        if (output === stdout && control === '\n') continue;
        expect(output).not.toContain(control);
      }
    }
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  }, 15_000);
});
