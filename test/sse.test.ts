import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startSseServer } from '../src/sse';
import { SERVER_NAME, SERVER_VERSION } from '../src/server';

describe('SSE Transport and Healthcheck Server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = await startSseServer({ port: 0, host: '127.0.0.1', handleSignals: false });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  it('responds with ok to /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe(SERVER_NAME);
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.transport).toBe('sse');
    expect(typeof body.uptime).toBe('number');
  });

  it('responds with ok to /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
  });

  it('handles OPTIONS preflight requests with CORS headers', async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('establishes SSE stream on GET /sse', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/sse`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    if (reader) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('event: endpoint');
      expect(text).toContain('/messages?sessionId=');
      controller.abort();
    }
  });

  it('returns 404 for POST /messages with missing or unknown session', async () => {
    const res = await fetch(`${baseUrl}/messages?sessionId=unknown-session-12345`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe('Session not found');
  });

  it('returns 404 for unknown endpoints', async () => {
    const res = await fetch(`${baseUrl}/unknown-path`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe('Not Found');
  });
});
