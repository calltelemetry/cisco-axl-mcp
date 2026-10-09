import { describe, it, expect } from 'vitest';
import { handleMcpFetchRequest } from '../src/fetch';

describe('Cisco AXL Universal Fetch / Streamable HTTP Handler', () => {
  it('handles CORS OPTIONS preflight', async () => {
    const req = new Request('https://mcp.internal/mcp', { method: 'OPTIONS' });
    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('handles GET /healthz and /health', async () => {
    const req = new Request('https://mcp.internal/healthz', { method: 'GET' });
    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; tools_count: number };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('cisco-axl-mcp');
    expect(body.tools_count).toBeGreaterThan(0);
  });

  it('handles JSON-RPC initialize', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2026-07-28');
    expect(body.result.serverInfo.name).toBe('cisco-axl-mcp');
  });

  it('handles JSON-RPC notifications/initialized', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(204);
  });

  it('handles JSON-RPC ping', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ping-axl',
        method: 'ping',
      }),
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result: Record<string, unknown>;
    };
    expect(body.id).toBe('ping-axl');
    expect(body.result).toEqual({});
  });

  it('handles JSON-RPC tools/list and returns discovery and execution tools', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { tools: Array<{ name: string; description: string }> };
    };
    const names = body.result.tools.map(t => t.name);
    expect(names).toContain('axl_list_objects');
    expect(names).toContain('axl_list_operations');
    expect(names).toContain('axl_describe_operation');
    expect(names).toContain('axl_execute');
  });

  it('handles JSON-RPC tools/call for axl_list_objects', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'axl_list_objects',
          arguments: { cucm_version: '14.0' },
        },
      }),
    });

    const res = await handleMcpFetchRequest(req, { AXL_MCP_ENABLED_OBJECTS: '*' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(body.result.content).toBeDefined();
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      wsdlVersion: string;
      objectCount: number;
      objects: string[];
    };
    expect(parsed.wsdlVersion).toBe('14.0');
    expect(parsed.objectCount).toBeGreaterThan(0);
    expect(parsed.objects).toContain('Phone');
  });

  it('returns -32700 on malformed JSON', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'invalid-json',
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('returns -32601 on unknown method', async () => {
    const req = new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'unknown/method',
      }),
    });

    const res = await handleMcpFetchRequest(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});
