import { describe, it, expect, vi } from 'vitest';
import { buildReturnedTags, handleTool } from '../src/tools/index';
import type { AxlAPIService } from '../src/services/axl/index';

describe('buildReturnedTags', () => {
  it('flat fields produce boolean map', () => {
    expect(buildReturnedTags(['name', 'model'])).toEqual({
      name: true,
      model: true,
    });
  });

  it('empty array produces empty object', () => {
    expect(buildReturnedTags([])).toEqual({});
  });

  it('single field produces single key', () => {
    expect(buildReturnedTags(['name'])).toEqual({ name: true });
  });

  // ---- Lab script: query-phone.cjs ----
  // service.executeOperation('getPhone', {
  //   name: 'SEP505C885DF37F',
  //   returnedTags: {
  //     name: true, builtInBridgeStatus: true, privacy: true,
  //     lines: { line: { index: true, dirn: { pattern: true },
  //       recordingFlag: true, recordingMediaSource: true, recordingProfileName: true } }
  //   }
  // })
  it('matches query-phone.cjs returnedTags structure', () => {
    const input = [
      'name',
      'builtInBridgeStatus',
      'privacy',
      'lines.line.index',
      'lines.line.dirn.pattern',
      'lines.line.recordingFlag',
      'lines.line.recordingMediaSource',
      'lines.line.recordingProfileName',
    ];

    const expected = {
      name: true,
      builtInBridgeStatus: true,
      privacy: true,
      lines: {
        line: {
          index: true,
          dirn: { pattern: true },
          recordingFlag: true,
          recordingMediaSource: true,
          recordingProfileName: true,
        },
      },
    };

    expect(buildReturnedTags(input)).toEqual(expected);
  });

  // ---- Lab script: audit-7975.cjs (listPhone) ----
  // returnedTags: { name: true, model: true, lines: { line: { dirn: { pattern: true } } } }
  it('matches audit-7975.cjs listPhone returnedTags', () => {
    const input = ['name', 'model', 'lines.line.dirn.pattern'];

    const expected = {
      name: true,
      model: true,
      lines: { line: { dirn: { pattern: true } } },
    };

    expect(buildReturnedTags(input)).toEqual(expected);
  });

  // ---- Lab script: audit-7975.cjs (getPhone - full config) ----
  // returnedTags: {
  //   name: true, model: true, builtInBridgeStatus: true,
  //   callInfoPrivacyStatus: true, allowCtiControlFlag: true, callingSearchSpaceName: true,
  //   lines: { line: { index: true, dirn: { pattern: true, routePartitionName: true },
  //     recordingFlag: true, recordingMediaSource: true, recordingProfileName: true,
  //     monitoringCssName: true } }
  // }
  it('matches audit-7975.cjs getPhone returnedTags', () => {
    const input = [
      'name',
      'model',
      'builtInBridgeStatus',
      'callInfoPrivacyStatus',
      'allowCtiControlFlag',
      'callingSearchSpaceName',
      'lines.line.index',
      'lines.line.dirn.pattern',
      'lines.line.dirn.routePartitionName',
      'lines.line.recordingFlag',
      'lines.line.recordingMediaSource',
      'lines.line.recordingProfileName',
      'lines.line.monitoringCssName',
    ];

    const expected = {
      name: true,
      model: true,
      builtInBridgeStatus: true,
      callInfoPrivacyStatus: true,
      allowCtiControlFlag: true,
      callingSearchSpaceName: true,
      lines: {
        line: {
          index: true,
          dirn: { pattern: true, routePartitionName: true },
          recordingFlag: true,
          recordingMediaSource: true,
          recordingProfileName: true,
          monitoringCssName: true,
        },
      },
    };

    expect(buildReturnedTags(input)).toEqual(expected);
  });

  // ---- Lab script: check-css-details.cjs (simple) ----
  // returnedTags: { name: true, callingSearchSpaceName: true }
  it('matches check-css-details.cjs simple returnedTags', () => {
    const input = ['name', 'callingSearchSpaceName'];
    const expected = { name: true, callingSearchSpaceName: true };
    expect(buildReturnedTags(input)).toEqual(expected);
  });

  // ---- Lab script: check-css-details.cjs (line details) ----
  // returnedTags: { lines: { line: { index: true, dirn: { pattern: true }, callForwardAll: true } } }
  it('matches check-css-details.cjs line returnedTags', () => {
    const input = [
      'lines.line.index',
      'lines.line.dirn.pattern',
      'lines.line.callForwardAll',
    ];

    const expected = {
      lines: {
        line: {
          index: true,
          dirn: { pattern: true },
          callForwardAll: true,
        },
      },
    };

    expect(buildReturnedTags(input)).toEqual(expected);
  });

  // ---- Edge cases ----
  it('multiple siblings at same nesting level', () => {
    const input = ['lines.line.dirn.pattern', 'lines.line.dirn.routePartitionName'];
    const expected = {
      lines: { line: { dirn: { pattern: true, routePartitionName: true } } },
    };
    expect(buildReturnedTags(input)).toEqual(expected);
  });

  it('deeper path does not overwrite shallower sibling', () => {
    // If "lines.line.recordingFlag" is set first, then "lines.line.dirn.pattern"
    // should not clobber the existing "line" object
    const input = ['lines.line.recordingFlag', 'lines.line.dirn.pattern'];
    const expected = {
      lines: { line: { recordingFlag: true, dirn: { pattern: true } } },
    };
    expect(buildReturnedTags(input)).toEqual(expected);
  });

  it('leaf then nested: deeper path upgrades a leaf to an object', () => {
    // If someone passes "lines" as flat AND "lines.line.index", the deeper
    // path should win (upgrade from true to nested object)
    const input = ['lines', 'lines.line.index'];
    const expected = {
      lines: { line: { index: true } },
    };
    expect(buildReturnedTags(input)).toEqual(expected);
  });
});

describe('handleTool returnedTags pipeline', () => {
  function createCapturingMock() {
    const calls: { operation: string; data: unknown }[] = [];
    const api: AxlAPIService = {
      executeOperation: async (_creds: unknown, operation: unknown, data: unknown) => {
        calls.push({ operation: String(operation), data });
        return { ok: true };
      },
    } as unknown as AxlAPIService;
    return { api, calls };
  }

  // Simulates what query-phone.cjs does:
  // service.executeOperation('getPhone', {
  //   name: 'SEP505C885DF37F',
  //   returnedTags: { name: true, builtInBridgeStatus: true, privacy: true,
  //     lines: { line: { index: true, dirn: { pattern: true }, ... } } }
  // })
  it('produces same payload as query-phone.cjs when using returnedTags array', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: { name: 'SEP505C885DF37F' },
        returnedTags: [
          'name',
          'builtInBridgeStatus',
          'privacy',
          'lines.line.index',
          'lines.line.dirn.pattern',
          'lines.line.recordingFlag',
          'lines.line.recordingMediaSource',
          'lines.line.recordingProfileName',
        ],
      },
      api
    );

    expect(calls).toHaveLength(1);

    // This is exactly what query-phone.cjs passes to executeOperation
    expect(calls[0]!.data).toEqual({
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        builtInBridgeStatus: true,
        privacy: true,
        lines: {
          line: {
            index: true,
            dirn: { pattern: true },
            recordingFlag: true,
            recordingMediaSource: true,
            recordingProfileName: true,
          },
        },
      },
    });
  });

  // Simulates audit-7975.cjs listPhone
  it('produces same payload as audit-7975.cjs listPhone', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'listPhone',
        data: { searchCriteria: { name: '%' } },
        returnedTags: ['name', 'model', 'lines.line.dirn.pattern'],
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({
      searchCriteria: { name: '%' },
      returnedTags: {
        name: true,
        model: true,
        lines: { line: { dirn: { pattern: true } } },
      },
    });
  });

  // Simulates check-css-details.cjs line query
  it('produces same payload as check-css-details.cjs line query', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: { name: 'SEP505C885DF37F' },
        returnedTags: [
          'lines.line.index',
          'lines.line.dirn.pattern',
          'lines.line.callForwardAll',
        ],
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({
      name: 'SEP505C885DF37F',
      returnedTags: {
        lines: {
          line: {
            index: true,
            dirn: { pattern: true },
            callForwardAll: true,
          },
        },
      },
    });
  });

  it('passes data through unchanged when returnedTags is omitted', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ name: 'SEP001122334455' });
  });

  it('passes data through unchanged when returnedTags is empty array', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: { name: 'SEP001122334455' },
        returnedTags: [],
      },
      api
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ name: 'SEP001122334455' });
  });

  it('returnedTags array overrides data.returnedTags if both provided', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: {
          name: 'SEP001122334455',
          returnedTags: { name: true, model: true },
        },
        returnedTags: ['name', 'callingSearchSpaceName'],
      },
      api
    );

    expect(calls).toHaveLength(1);
    // The top-level returnedTags array should override data.returnedTags
    expect(calls[0]!.data).toEqual({
      name: 'SEP001122334455',
      returnedTags: { name: true, callingSearchSpaceName: true },
    });
  });

  it('data.returnedTags object passes through when no array provided', async () => {
    const { api, calls } = createCapturingMock();

    await handleTool(
      'axl_execute',
      {
        cucm_host: 'test.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '15.0',
        operation: 'getPhone',
        data: {
          name: 'SEP001122334455',
          returnedTags: { name: true, model: true },
        },
      },
      api
    );

    expect(calls).toHaveLength(1);
    // When no array, data passes through as-is including its own returnedTags
    expect(calls[0]!.data).toEqual({
      name: 'SEP001122334455',
      returnedTags: { name: true, model: true },
    });
  });
});
