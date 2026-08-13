import { describe, expect, it } from 'vitest';
import {
  CLI_FAILURE_ENVELOPE_SCHEMA,
  CLI_SCHEMA_VERSION,
  CLI_SUCCESS_ENVELOPE_SCHEMA,
  CliError,
  failureEnvelope,
  successEnvelope,
  toCliFailure,
} from '../src/cli/output';

describe('CLI output envelopes', () => {
  it('emits the stable cisco-axl.cli.v1 success envelope', () => {
    const envelope = successEnvelope(
      { rows: [{ name: 'cm-pub' }] },
      { operation: 'listCallManager', cucm_version: '11.5' }
    );

    expect(CLI_SUCCESS_ENVELOPE_SCHEMA.parse(envelope)).toEqual({
      schema_version: 'cisco-axl.cli.v1',
      ok: true,
      data: { rows: [{ name: 'cm-pub' }] },
      meta: { operation: 'listCallManager', cucm_version: '11.5' },
    });
    expect(CLI_SCHEMA_VERSION).toBe('cisco-axl.cli.v1');
  });

  it('emits stable structured validation failures', () => {
    const envelope = failureEnvelope(
      {
        code: 'CLI_SCHEMA_INVALID',
        message: 'Payload validation failed',
        details: [{ path: 'phone.protocol', kind: 'enum', enum: ['SIP', 'SCCP'] }],
      },
      { operation: 'addPhone', cucm_version: '15.0' }
    );

    expect(CLI_FAILURE_ENVELOPE_SCHEMA.parse(envelope)).toEqual({
      schema_version: 'cisco-axl.cli.v1',
      ok: false,
      error: {
        code: 'CLI_SCHEMA_INVALID',
        message: 'Payload validation failed',
        details: [{ path: 'phone.protocol', kind: 'enum', enum: ['SIP', 'SCCP'] }],
      },
      meta: { operation: 'addPhone', cucm_version: '15.0' },
    });
  });

  it.each([
    ['input', 2],
    ['unsupported', 3],
    ['transport', 4],
    ['policy', 5],
  ] as const)('retains deterministic exit code %s -> %i', (category, exitCode) => {
    const failure = toCliFailure(
      new CliError(`CLI_${category.toUpperCase()}`, `${category} failed`, exitCode)
    );

    expect(failure.exitCode).toBe(exitCode);
    expect(failure.envelope.error.code).toBe(`CLI_${category.toUpperCase()}`);
  });

  it('redacts supplied secrets from error envelopes and diagnostics', () => {
    const failure = toCliFailure(
      new Error('Authentication failed for axl-admin with password super-secret'),
      ['axl-admin', 'super-secret']
    );
    const serialized = JSON.stringify(failure.envelope);

    expect(failure.exitCode).toBe(4);
    expect(serialized).not.toContain('axl-admin');
    expect(serialized).not.toContain('super-secret');
    expect(failure.diagnostic).not.toContain('axl-admin');
    expect(failure.diagnostic).not.toContain('super-secret');
  });

  it('redacts externally supplied error codes and failure metadata', () => {
    const secret = 'CODE-META-SECRET-731';
    const failure = toCliFailure({ code: `AXL_${secret}`, message: 'transport failed' }, [secret], {
      operation: secret,
      nested: { value: secret },
    });

    expect(JSON.stringify(failure.envelope)).not.toContain(secret);
    expect(failure.diagnostic).not.toContain(secret);
    expect(failure.envelope).toMatchObject({
      error: { code: 'AXL_***', message: 'transport failed' },
      meta: { operation: '***', nested: { value: '***' } },
    });
  });
});
