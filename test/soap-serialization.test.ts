import { describe, expect, it } from 'vitest';
import CiscoAxlService from 'cisco-axl';

interface CapturableSoapClient {
  httpClient: {
    request(
      location: string,
      xml: string,
      callback: (error: Error) => void
    ): { headers: Record<string, string> };
  };
}

describe('strong-soap transport representation', () => {
  it('serializes listChange simple content with value and attributes transport keys', async () => {
    const service = new CiscoAxlService('cucm.example.test', 'axl-user', 'secret', '15.0', {
      logging: { level: 'error', handler: () => {} },
      retry: { retries: 0 },
    });
    const client = await (
      service as unknown as { _getClient(): Promise<CapturableSoapClient> }
    )._getClient();
    let requestXml = '';
    client.httpClient.request = (_location, xml, callback) => {
      requestXml = xml;
      queueMicrotask(() => callback(new Error('capture complete')));
      return { headers: {} };
    };

    await expect(
      service.executeOperation('listChange', {
        startChangeId: { value: 42, attributes: { queueId: 'q-1' } },
      })
    ).rejects.toThrow('capture complete');

    expect(requestXml).toMatch(/<startChangeId queueId="q-1">42<\/startChangeId>/);
    expect(requestXml).not.toContain('$value');
    expect(requestXml).not.toContain('$attributes');
  }, 30_000);
});
