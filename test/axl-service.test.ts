import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAuditDir, writeAuditEntry } from '../src/lib/audit-log';

// Mock getAxlClient to avoid real CUCM connections
vi.mock('../src/lib/axl-client', () => {
  const mockClient = {
    executeOperation: vi.fn().mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } }),
  };
  return {
    getAxlClient: vi.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

import { AxlAPIService } from '../src/services/axl/index';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __mockClient: mockClient } = await import('../src/lib/axl-client') as any;

const creds = { host: 'test-host', username: 'admin', password: 'pass', version: '14.0' };
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-svc-'));
  setAuditDir(tempDir);
  vi.clearAllMocks();
  mockClient.executeOperation.mockResolvedValue({ return: { phone: [{ name: 'SEP111' }] } });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AxlAPIService.executeOperation', () => {
  it('calls getAxlClient and returns result', async () => {
    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    expect(result).toEqual({ return: { phone: [{ name: 'SEP111' }] } });
    expect(mockClient.executeOperation).toHaveBeenCalledWith('getPhone', { name: 'SEP111' }, undefined);
  });

  it('records successful operation to audit log', async () => {
    const service = new AxlAPIService();
    await service.executeOperation(creds, 'listPhone', { searchCriteria: { name: '%' } });

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const last = entries[entries.length - 1];
    expect(last.operation).toBe('listPhone');
    expect(last.status).toBe('ok');
    expect(last.rows).toBe(1);
  });

  it('records failed operation to audit log and rethrows', async () => {
    mockClient.executeOperation.mockRejectedValue(new Error('401 Unauthorized'));

    const service = new AxlAPIService();
    await expect(service.executeOperation(creds, 'getPhone', { name: 'X' })).rejects.toThrow('401 Unauthorized');

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));

    const last = entries[entries.length - 1];
    expect(last.status).toBe('error');
    expect(last.error).toContain('401');
  });

  it('records throttle events correctly', async () => {
    const origRetries = process.env.AXL_MCP_MAX_RETRIES;
    const origDelay = process.env.AXL_MCP_RETRY_BASE_DELAY_MS;
    process.env.AXL_MCP_MAX_RETRIES = '1';
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = '1';

    mockClient.executeOperation.mockRejectedValue(new Error('Maximum AXL Memory Allocation Consumed'));

    const service = new AxlAPIService();
    await expect(service.executeOperation(creds, 'listPhone', {})).rejects.toThrow('Memory');

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));

    const throttled = entries.filter((e: { status: string }) => e.status === 'throttled');
    expect(throttled.length).toBeGreaterThanOrEqual(1);

    process.env.AXL_MCP_MAX_RETRIES = origRetries;
    process.env.AXL_MCP_RETRY_BASE_DELAY_MS = origDelay;
  });

  it('applies adaptive delay when recent throttle events exist', async () => {
    // Seed audit log with a recent throttle event
    writeAuditEntry(creds.host, {
      ts: new Date().toISOString(),
      operation: 'listPhone',
      durationMs: 500,
      status: 'throttled',
      error: 'rate limit',
    });

    // Mock the delay function by using fake timers
    vi.useFakeTimers();

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new AxlAPIService();
    const promise = service.executeOperation(creds, 'getPhone', { name: 'SEP111' });

    // Advance past adaptive delay (2000ms for 1 throttle event)
    await vi.advanceTimersByTimeAsync(3000);
    await promise;

    vi.useRealTimers();

    const rateMsg = stderrSpy.mock.calls.find(c => String(c[0]).includes('[AXL Rate]'));
    expect(rateMsg).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('records rows count for list results', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: { phone: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] },
    });

    const service = new AxlAPIService();
    await service.executeOperation(creds, 'listPhone', {});

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBe(3);
  });

  it('handles results with no rows (non-list)', async () => {
    mockClient.executeOperation.mockResolvedValue({ return: 'ok' });

    const service = new AxlAPIService();
    await service.executeOperation(creds, 'addPhone', { phone: {} });

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBeUndefined();
  });

  it('handles single object result (not wrapped in array)', async () => {
    mockClient.executeOperation.mockResolvedValue({
      return: { phone: { name: 'SEP111', model: 'Cisco 8845' } },
    });

    const service = new AxlAPIService();
    const result = await service.executeOperation(creds, 'getPhone', { name: 'SEP111' });
    expect(result).toBeDefined();

    const { readFileSync } = await import('node:fs');
    const safe = creds.host.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const content = readFileSync(join(tempDir, `${safe}.jsonl`), 'utf-8');
    const entries = content.trim().split('\n').map(l => JSON.parse(l));
    const last = entries[entries.length - 1];
    expect(last.rows).toBe(1); // single object counted as 1 row
  });
});

describe('AxlAPIService.listAll (integrated)', () => {
  it('paginates through real executeOperation', async () => {
    let callCount = 0;
    mockClient.executeOperation.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { return: { phone: Array.from({ length: 1000 }, (_, i) => ({ name: `P${i}` })) } };
      }
      return { return: { phone: Array.from({ length: 50 }, (_, i) => ({ name: `P${1000 + i}` })) } };
    });

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', { searchCriteria: { name: '%' } });

    expect(result.rows).toHaveLength(1050);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('handles empty response from CUCM', async () => {
    mockClient.executeOperation.mockResolvedValue({});

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', {});

    expect(result.rows).toHaveLength(0);
    expect(result.pages).toBe(1);
  });

  it('handles null/primitive return values', async () => {
    mockClient.executeOperation.mockResolvedValue(null);

    const service = new AxlAPIService();
    const result = await service.listAll(creds, 'listPhone', {});

    expect(result.rows).toHaveLength(0);
  });
});
