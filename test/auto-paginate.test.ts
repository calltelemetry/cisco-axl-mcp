import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxlAPIService } from '../src/services/axl/index';
import { setAuditDir } from '../src/lib/audit-log';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'axl-paginate-'));
  setAuditDir(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePhones(count: number, offset = 0): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ name: `SEP${String(i + offset).padStart(12, '0')}` }));
}

describe('AxlAPIService.listAll', () => {
  it('fetches a single page when results fit', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ return: { phone: makePhones(5) } });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    const result = await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      { searchCriteria: { name: '%' } },
    );

    expect(result.rows).toHaveLength(5);
    expect(result.totalFetched).toBe(5);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('auto-paginates across multiple pages', async () => {
    let callCount = 0;
    const mockExecute = vi.fn().mockImplementation(async () => {
      callCount++;
      // First call: full page, second call: partial page
      if (callCount === 1) return { return: { phone: makePhones(1000, 0) } };
      return { return: { phone: makePhones(50, 1000) } };
    });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    const result = await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      { searchCriteria: { name: '%' } },
    );

    expect(result.rows).toHaveLength(1050);
    expect(result.totalFetched).toBe(1050);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('truncates at max rows and sets truncated flag', async () => {
    const originalEnv = process.env.AXL_MCP_MAX_AUTOPAGINATE;
    process.env.AXL_MCP_MAX_AUTOPAGINATE = '1500';

    const mockExecute = vi.fn().mockResolvedValue({ return: { phone: makePhones(1000) } });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    const result = await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      { searchCriteria: { name: '%' } },
    );

    expect(result.truncated).toBe(true);
    expect(result.totalFetched).toBeLessThanOrEqual(1500);

    process.env.AXL_MCP_MAX_AUTOPAGINATE = originalEnv;
  });

  it('passes skip and first in page data', async () => {
    const calls: Record<string, unknown>[] = [];
    const mockExecute = vi.fn().mockImplementation(async (_creds: unknown, _op: unknown, data: unknown) => {
      calls.push(data as Record<string, unknown>);
      return { return: { phone: makePhones(10) } }; // Less than page size = last page
    });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      { searchCriteria: { name: '%' } },
    );

    expect(calls[0]).toMatchObject({ skip: '0', first: '1000', searchCriteria: { name: '%' } });
  });

  it('handles empty results', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ return: {} });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    const result = await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      {},
    );

    expect(result.rows).toHaveLength(0);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('handles SQL-style row results', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      return: { row: [{ pkid: '1', name: 'phone1' }, { pkid: '2', name: 'phone2' }] },
    });
    const service = new AxlAPIService();
    service.executeOperation = mockExecute;

    const result = await service.listAll(
      { host: 'test', username: 'u', password: 'p', version: '14.0' },
      'listPhone',
      {},
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ pkid: '1' });
  });
});
