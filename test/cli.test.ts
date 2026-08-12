import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies } from '../src/cli';
import { validateOperationInput } from '../src/cli/schema-validation';
import { loadAxlVersionArtifacts } from '../src/types/generated/axl-version-loader';
import type { OperationSchema } from '../src/types/generated/axl-generated-types';
import type { RunAxlOptions } from '../src/lib/axl-runner';
import { MutationGrantAuthority } from '../src/lib/mutation-grants';

const completeEnv = {
  CUCM_HOST: 'cucm.example.test',
  CUCM_USERNAME: 'axl-admin',
  CUCM_PASSWORD: 'super-secret',
  CUCM_VERSION: '15.0',
};

const unsafeJsonControls = ['\u0085', '\u009b', '\u2028', '\u2029'];
const unsafeDiagnosticControls = [
  ...Array.from({ length: 0x20 }, (_, codePoint) => String.fromCharCode(codePoint)),
  String.fromCharCode(0x7f),
  ...Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)),
  '\u2028',
  '\u2029',
];

function expectNoRawUnsafeJsonControls(...outputs: string[]): void {
  for (const output of outputs) {
    for (const control of unsafeJsonControls) expect(output).not.toContain(control);
  }
}

function harness(overrides: Partial<CliDependencies> = {}) {
  let stdout = '';
  let stderr = '';
  const calls: RunAxlOptions[] = [];
  const dependencies: CliDependencies = {
    env: completeEnv,
    stdout: { write: value => ((stdout += String(value)), true) },
    stderr: { write: value => ((stderr += String(value)), true) },
    readStdin: async () => '',
    runAxl: async options => {
      calls.push(options);
      return { result: 'ok' };
    },
    ...overrides,
  };
  return {
    dependencies,
    calls,
    stdout: () => stdout,
    stderr: () => stderr,
    envelope: () => JSON.parse(stdout),
  };
}

describe('schema-driven CLI discovery', () => {
  it('lists supported versions without requiring credentials', async () => {
    const cli = harness({ env: {} });

    await expect(runCli(['versions'], cli.dependencies)).resolves.toBe(0);
    expect(cli.envelope()).toEqual({
      schema_version: 'cisco-axl.cli.v1',
      ok: true,
      data: { versions: ['11.0', '11.5', '12.0', '12.5', '14.0', '15.0'] },
      meta: { command: 'versions' },
    });
    expect(cli.stderr()).toBe('');
  });

  it('lists versioned objects and object operations from generated catalogs', async () => {
    const objects = harness({ env: {} });
    expect(await runCli(['objects', '--version', '11.5'], objects.dependencies)).toBe(0);
    expect(objects.envelope().data.objects).toContain('CallManager');
    expect(objects.envelope().meta).toEqual({ command: 'objects', cucm_version: '11.5' });

    const operations = harness({ env: {} });
    expect(
      await runCli(
        ['operations', '--object', 'CallManager', '--version', '15.0'],
        operations.dependencies
      )
    ).toBe(0);
    expect(operations.envelope().data.operations).toContainEqual({
      verb: 'get',
      operation: 'getCallManager',
    });
  }, 15_000);

  it('describes a dynamic operation using the selected version schema', async () => {
    const cli = harness({ env: {} });

    expect(
      await runCli(['describe', 'getCallManager', '--version', '11.5'], cli.dependencies)
    ).toBe(0);
    expect(cli.envelope().data.fields).toHaveProperty('name');
    expect(cli.envelope().data.fields).toHaveProperty('uuid');
    expect(cli.envelope().data.choices[0].options).toEqual([['name'], ['uuid']]);
    expect(cli.envelope().meta).toEqual({
      command: 'describe',
      operation: 'getCallManager',
      cucm_version: '11.5',
    });
  });

  it.each([
    [['objects', '--version', '16.0'], 'CLI_UNSUPPORTED_VERSION'],
    [['describe', 'listCiscoCloudOnboarding', '--version', '11.0'], 'CLI_UNSUPPORTED_OPERATION'],
    [['operations', '--object', 'NotAnAxlObject', '--version', '15.0'], 'CLI_UNSUPPORTED_OBJECT'],
  ])('returns exit 3 for unsupported generated capability: %j', async (argv, code) => {
    const cli = harness({ env: {} });

    expect(await runCli(argv as string[], cli.dependencies)).toBe(3);
    expect(cli.envelope()).toMatchObject({ ok: false, error: { code } });
    if (code === 'CLI_UNSUPPORTED_OBJECT') {
      expect(cli.envelope().error.details).toEqual({
        object: 'NotAnAxlObject',
        cucm_version: '15.0',
      });
    }
    expect(cli.stdout().trim().split('\n')).toHaveLength(1);
  });

  it.each([
    {
      label: 'operation',
      argv: ['describe', `notAnOperation${unsafeJsonControls.join('')}`, '--version', '15.0'],
      detail: 'operation',
      code: 'CLI_UNSUPPORTED_OPERATION',
    },
    {
      label: 'object',
      argv: [
        'operations',
        '--object',
        `NotAnObject${unsafeJsonControls.join('')}`,
        '--version',
        '15.0',
      ],
      detail: 'object',
      code: 'CLI_UNSUPPORTED_OBJECT',
    },
  ])(
    'escapes unsafe JSON controls from unsupported $label failure output',
    async ({ argv, detail, code }) => {
      const cli = harness({ env: {} });

      expect(await runCli(argv, cli.dependencies)).toBe(3);
      expectNoRawUnsafeJsonControls(cli.stdout(), cli.stderr());
      expect(cli.envelope()).toMatchObject({
        error: {
          code,
          details: { [detail]: expect.stringContaining(unsafeJsonControls.slice(0, 2).join('')) },
        },
      });
    }
  );
});

describe('operation payload validation', () => {
  it('rejects null for non-nillable opaque fields while accepting opaque JSON values', () => {
    const schema: OperationSchema = {
      verb: 'update',
      object: 'Synthetic',
      kind: 'crud',
      fields: {
        opaque: {
          type: 'opaque',
          minOccurs: 0,
          maxOccurs: 1,
          nillable: false,
          opaque: true,
        },
      },
      choices: [],
      sequences: [],
      attributes: {},
    };

    expect(() => validateOperationInput(schema, {}, { opaque: null })).toThrowError(
      expect.objectContaining({
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'opaque', kind: 'type', expected: 'opaque' }),
        ]),
      })
    );
    expect(validateOperationInput(schema, {}, { opaque: { vendor: true } })).toEqual({
      opaque: { vendor: true },
    });
    expect(validateOperationInput(schema, {}, { opaque: '<vendor />' })).toEqual({
      opaque: '<vendor />',
    });
    expect(validateOperationInput(schema, {}, { opaque: 42 })).toEqual({ opaque: 42 });
  });

  it('accepts null only for nillable synthetic and generated opaque fields', async () => {
    const nillableSchema: OperationSchema = {
      verb: 'update',
      object: 'Synthetic',
      kind: 'crud',
      fields: {
        opaque: {
          type: 'opaque',
          minOccurs: 0,
          maxOccurs: 1,
          nillable: true,
          opaque: true,
        },
      },
      choices: [],
      sequences: [],
      attributes: {},
    };
    expect(validateOperationInput(nillableSchema, {}, { opaque: null })).toEqual({
      opaque: null,
    });

    const version15 = await loadAxlVersionArtifacts('15.0');
    expect(() =>
      validateOperationInput(version15.operationSchemas.updatePhone!, version15.enums, {
        name: 'SEP001',
        vendorConfig: null,
      })
    ).toThrowError(expect.objectContaining({ code: 'CLI_SCHEMA_INVALID' }));

    const version11 = await loadAxlVersionArtifacts('11.0');
    expect(
      validateOperationInput(version11.operationSchemas.addAppServerInfo!, version11.enums, {
        appServerInfo: { content: null },
      })
    ).toEqual({ appServerInfo: { content: null } });
  }, 15_000);

  it('reports each missing required enum or array exactly once as required', () => {
    const requiredSchema: OperationSchema = {
      verb: 'add',
      object: 'Synthetic',
      kind: 'crud',
      fields: {
        mode: {
          type: 'string',
          minOccurs: 1,
          maxOccurs: 1,
          nillable: false,
          required: true,
          enum: ['Enabled', 'Disabled'],
        },
        members: {
          type: 'array',
          minOccurs: 1,
          maxOccurs: 'unbounded',
          nillable: false,
          required: true,
          items: { type: 'string', minOccurs: 1, maxOccurs: 1, nillable: false },
        },
      },
      choices: [],
      sequences: [],
      attributes: {},
    };

    let details: unknown;
    try {
      validateOperationInput(requiredSchema, {}, {});
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }
    expect(details).toEqual([
      expect.objectContaining({ path: 'mode', kind: 'required', expected: 'string' }),
      expect.objectContaining({ path: 'members', kind: 'required', expected: 'array' }),
    ]);
  });

  it('returns path and choice details when mutually exclusive fields are combined', async () => {
    const artifacts = await loadAxlVersionArtifacts('15.0');

    expect(() =>
      validateOperationInput(artifacts.operationSchemas.getCallManager!, artifacts.enums, {
        name: 'cm-pub',
        uuid: '{11111111-1111-1111-1111-111111111111}',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'CLI_SCHEMA_INVALID',
        details: expect.arrayContaining([
          expect.objectContaining({
            path: '$',
            kind: 'choice',
            choice: { minOccurs: 1, maxOccurs: 1, options: [['name'], ['uuid']] },
          }),
        ]),
      })
    );
  });

  it('returns field path and allowed enum values', async () => {
    const artifacts = await loadAxlVersionArtifacts('15.0');

    expect(() =>
      validateOperationInput(artifacts.operationSchemas.addPhone!, artifacts.enums, {
        phone: { protocol: 'NOT-A-PROTOCOL' },
      })
    ).toThrowError(
      expect.objectContaining({
        details: expect.arrayContaining([
          expect.objectContaining({
            path: 'phone.protocol',
            kind: 'enum',
            enum: expect.arrayContaining(['SIP', 'SCCP']),
          }),
        ]),
      })
    );
  });

  it('returns array expectations for repeated fields', async () => {
    const artifacts = await loadAxlVersionArtifacts('15.0');

    expect(() =>
      validateOperationInput(artifacts.operationSchemas.addUser!, artifacts.enums, {
        user: { associatedDevices: { device: 'SEP001' } },
      })
    ).toThrowError(
      expect.objectContaining({
        details: expect.arrayContaining([
          expect.objectContaining({
            path: 'user.associatedDevices.device',
            kind: 'array',
            array: { minItems: 0, maxItems: 'unbounded' },
          }),
        ]),
      })
    );
  });
});

describe('CLI execution', () => {
  it.each([
    {
      label: 'split password flag',
      argv: ['execute', 'getPhone', '--password', 'ALPHA BETA-UNIQUE-731'],
      secrets: ['ALPHA', 'BETA-UNIQUE-731'],
    },
    {
      label: 'equals password flag',
      argv: ['execute', 'getPhone', '--password=ALPHA BETA-UNIQUE-731'],
      secrets: ['ALPHA', 'BETA-UNIQUE-731'],
    },
    {
      label: 'unknown value-bearing option',
      argv: ['execute', 'getPhone', '--mystery=GAMMA SECRET-SUFFIX-884'],
      secrets: ['GAMMA', 'SECRET-SUFFIX-884'],
    },
  ])('rejects $label without echoing attached or following values', async ({ argv, secrets }) => {
    const cli = harness({ env: {} });

    expect(await runCli(argv, cli.dependencies)).toBe(2);
    expect(cli.envelope()).toMatchObject({
      ok: false,
      error: { code: 'CLI_USAGE', message: 'Sensitive or value-bearing options are not accepted' },
    });
    for (const secret of secrets) {
      expect(cli.stdout()).not.toContain(secret);
      expect(cli.stderr()).not.toContain(secret);
    }
  });

  it('escapes control characters in unknown option diagnostics without injecting output lines', async () => {
    const cli = harness({ env: {} });
    const token = '--unknown\r\nFORGED\tEFFECT\u0085\u009b\u2028\u2029';

    expect(await runCli(['execute', 'getPhone', token], cli.dependencies)).toBe(2);
    for (const control of ['\r', '\t', '\u0085', '\u009b', '\u2028', '\u2029']) {
      expect(cli.stdout()).not.toContain(control);
      expect(cli.stderr()).not.toContain(control);
    }
    expect(cli.stdout().trim().split('\n')).toHaveLength(1);
    expect(cli.stderr().trimEnd().split('\n')).toHaveLength(1);
  });

  it('validates and dispatches a read through strict runAxl', async () => {
    const cli = harness();

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], cli.dependencies)
    ).toBe(0);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]).toMatchObject({
      source: 'cli',
      validationMode: 'strict',
      request: {
        operation: 'getPhone',
        data: { name: 'SEP001' },
        tlsMode: 'secure',
        credentials: {
          host: 'cucm.example.test',
          username: 'axl-admin',
          password: 'super-secret',
          version: '15.0',
        },
      },
    });
    expect(cli.calls[0]!.mutationGrant).toBeUndefined();
    expect(cli.envelope()).toMatchObject({
      ok: true,
      data: { result: 'ok' },
      meta: {
        command: 'execute',
        operation: 'getPhone',
        cucm_version: '15.0',
        tls_mode: 'secure',
      },
    });
    expect(cli.stderr()).toBe('');
  });

  it('escapes unsafe JSON controls in successful output without changing parsed payload values', async () => {
    const result = `value${unsafeJsonControls.join('')}`;
    const cli = harness({ runAxl: async () => ({ result }) });

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], cli.dependencies)
    ).toBe(0);
    expectNoRawUnsafeJsonControls(cli.stdout(), cli.stderr());
    expect(cli.envelope().data).toEqual({ result });
  });

  it('rejects schema-invalid input before SOAP dispatch', async () => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({ runAxl: runner });

    expect(await runCli(['execute', 'getPhone', '--data', '{"name":123}'], cli.dependencies)).toBe(
      2
    );
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope().error.details).toContainEqual(
      expect.objectContaining({ path: 'name', kind: 'type', expected: 'string' })
    );
  });

  it('escapes unsafe JSON controls from schema detail output without changing the field key', async () => {
    const unknownField = `unknown${unsafeJsonControls.join('')}`;
    const cli = harness();

    expect(
      await runCli(
        ['execute', 'getPhone', '--data', JSON.stringify({ name: 'SEP001', [unknownField]: true })],
        cli.dependencies
      )
    ).toBe(2);
    expectNoRawUnsafeJsonControls(cli.stdout(), cli.stderr());
    expect(cli.envelope().error.details).toContainEqual(
      expect.objectContaining({ kind: 'unknown', keys: [unknownField] })
    );
  });

  it('rejects auto-pagination for non-list operations before SOAP dispatch', async () => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({ runAxl: runner });

    expect(
      await runCli(
        ['execute', 'getPhone', '--data', '{"name":"SEP001"}', '--auto-page'],
        cli.dependencies
      )
    ).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope()).toMatchObject({ error: { code: 'CLI_AUTOPAGE_INVALID' } });
  });

  it('validates returnedTags fields before SOAP dispatch', async () => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({ runAxl: runner });

    expect(
      await runCli(
        [
          'execute',
          'listCallManager',
          '--data',
          '{"searchCriteria":{},"returnedTags":{"notAField":""}}',
        ],
        cli.dependencies
      )
    ).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope().error.details).toContainEqual(
      expect.objectContaining({
        path: 'returnedTags',
        kind: 'unknown',
        keys: ['notAField'],
      })
    );
  });

  it('rejects conflicting --data and stdin before SOAP dispatch', async () => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({ readStdin: async () => '{"name":"stdin"}', runAxl: runner });

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"flag"}'], cli.dependencies)
    ).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope()).toMatchObject({ error: { code: 'CLI_INPUT_CONFLICT' } });
  });

  it('fails safely when a required secret is missing', async () => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({
      env: { ...completeEnv, CUCM_PASSWORD: undefined },
      runAxl: runner,
    });

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], cli.dependencies)
    ).toBe(2);
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope()).toMatchObject({ error: { code: 'CLI_CREDENTIALS_MISSING' } });
    expect(cli.stdout()).not.toContain('super-secret');
    expect(cli.stderr()).not.toContain('super-secret');
  });

  it('redacts environment credentials from transport failures', async () => {
    const cli = harness({
      runAxl: async () => {
        throw new Error('401 for axl-admin using super-secret');
      },
    });

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], cli.dependencies)
    ).toBe(4);
    expect(cli.stdout()).not.toContain('axl-admin');
    expect(cli.stdout()).not.toContain('super-secret');
    expect(cli.stderr()).not.toContain('axl-admin');
    expect(cli.stderr()).not.toContain('super-secret');
  });

  it('escapes untrusted transport diagnostics to one line while preserving envelope values', async () => {
    const message = `transport failed for super-secret: ${unsafeDiagnosticControls.join('')} ordinary tail`;
    const cli = harness({
      runAxl: async () => {
        throw new Error(message);
      },
    });

    expect(
      await runCli(['execute', 'getPhone', '--data', '{"name":"SEP001"}'], cli.dependencies)
    ).toBe(4);

    const stdoutBody = cli.stdout().slice(0, -1);
    const diagnostic = cli.stderr().slice(0, -1);
    expect(cli.stdout().endsWith('\n')).toBe(true);
    expect(cli.stdout().split('\n')).toHaveLength(2);
    expect(cli.stderr().endsWith('\n')).toBe(true);
    expect(cli.stderr().split('\n')).toHaveLength(2);
    for (const control of unsafeDiagnosticControls) {
      expect(diagnostic).not.toContain(control);
      expect(stdoutBody).not.toContain(control);
    }
    expect(diagnostic).toContain('CLI_AXL_FAILURE: transport failed for ***:');
    expect(diagnostic).toContain('ordinary tail');
    expect(diagnostic).not.toContain('super-secret');
    expect(cli.envelope()).toMatchObject({
      error: {
        code: 'CLI_AXL_FAILURE',
        message: message.replace('super-secret', '***'),
      },
    });
  });

  it('visibly reports opt-in insecure TLS without polluting stdout', async () => {
    const cli = harness();

    expect(
      await runCli(
        ['execute', 'getPhone', '--data', '{"name":"SEP001"}', '--insecure'],
        cli.dependencies
      )
    ).toBe(0);
    expect(cli.envelope().meta.tls_mode).toBe('insecure');
    expect(cli.stderr()).toBe('WARNING: TLS certificate verification is disabled for this call.\n');
    expect(cli.stdout().trim().split('\n')).toHaveLength(1);
  });

  it.each([
    [
      ['execute', 'updatePhone', '--data', '{"name":"SEP001","description":"updated"}'],
      'CLI_MUTATION_WRITE_REQUIRED',
    ],
    [
      [
        'execute',
        'updatePhone',
        '--data',
        '{"name":"SEP001","description":"updated"}',
        '--write',
        '--confirm',
        'wrong-operation',
      ],
      'CLI_MUTATION_CONFIRMATION_INVALID',
    ],
  ])('rejects mutation without all human and grant safeguards', async (argv, code) => {
    const runner = vi.fn(async () => ({ unreachable: true }));
    const cli = harness({ runAxl: runner });

    expect(await runCli(argv as string[], cli.dependencies)).toBe(5);
    expect(runner).not.toHaveBeenCalled();
    expect(cli.envelope()).toMatchObject({ error: { code } });
  });

  it('creates a target/schema/package-bound mutation grant before strict write dispatch', async () => {
    const cli = harness();

    expect(
      await runCli(
        [
          'execute',
          'updatePhone',
          '--data',
          '{"name":"SEP001","description":"updated"}',
          '--write',
          '--confirm',
          'updatePhone',
        ],
        cli.dependencies
      )
    ).toBe(0);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]!.mutationGrant).toMatchObject({
      target: { host: 'cucm.example.test', version: '15.0' },
      operation: 'updatePhone',
      packageVersion: expect.any(String),
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('signs CLI grants with the same injected authority used by the strict runner', async () => {
    const authority = new MutationGrantAuthority(Buffer.alloc(32, 7));
    const cli = harness({
      runnerDependencies: { grantAuthority: authority },
      runAxl: async (options, dependencies) => {
        expect(options.mutationGrant).toBeDefined();
        expect(dependencies?.grantAuthority?.verify(options.mutationGrant!)).toBe(true);
        return { updated: true };
      },
    });

    expect(
      await runCli(
        [
          'execute',
          'updatePhone',
          '--data',
          '{"name":"SEP001","description":"updated"}',
          '--write',
          '--confirm',
          'updatePhone',
        ],
        cli.dependencies
      )
    ).toBe(0);
  });

  it('adapts SQL query files to executeSQLQuery', async () => {
    const cli = harness({ readFile: async () => Buffer.from('select name from device') });

    expect(await runCli(['sql', 'query', '--file', 'query.sql'], cli.dependencies)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      source: 'cli',
      validationMode: 'strict',
      request: { operation: 'executeSQLQuery', data: { sql: 'select name from device' } },
    });
    expect(cli.calls[0]!.mutationGrant).toBeUndefined();
  });

  it('requires SQL update confirmation and dispatches with a mutation grant', async () => {
    const denied = harness({ readFile: async () => Buffer.from('update device set name=name') });
    expect(await runCli(['sql', 'update', '--file', 'update.sql'], denied.dependencies)).toBe(5);
    expect(denied.calls).toHaveLength(0);

    const allowed = harness({ readFile: async () => Buffer.from('update device set name=name') });
    expect(
      await runCli(
        ['sql', 'update', '--file', 'update.sql', '--write', '--confirm', 'sql-update'],
        allowed.dependencies
      )
    ).toBe(0);
    expect(allowed.calls[0]).toMatchObject({
      request: {
        operation: 'executeSQLUpdate',
        data: { sql: 'update device set name=name' },
      },
      mutationGrant: { operation: 'executeSQLUpdate' },
    });
  });
});
