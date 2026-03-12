import { describe, it, expect } from 'vitest';
import { getTools, handleTool } from '../src/tools/index';
import type { AxlAPIService } from '../src/services/axl/index';

const createMockAxlAPI = (): AxlAPIService =>
  ({
    executeOperation: async () => ({ ok: true }),
  }) as unknown as AxlAPIService;

describe('MCP Protocol Conformance', () => {
  it('all tools should have valid inputSchema structure', () => {
    getTools().forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    });
  });

  it('all tools should have annotations with required hints', () => {
    const validHintKeys = ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
    getTools().forEach(tool => {
      expect(tool.annotations, `Tool ${tool.name} is missing annotations`).toBeDefined();
      const annotations = tool.annotations!;
      expect(typeof annotations.title).toBe('string');
      expect(typeof annotations.readOnlyHint).toBe('boolean');
      expect(typeof annotations.destructiveHint).toBe('boolean');
      expect(typeof annotations.idempotentHint).toBe('boolean');
      expect(typeof annotations.openWorldHint).toBe('boolean');
      // No unexpected keys
      for (const key of Object.keys(annotations)) {
        expect(validHintKeys, `Tool ${tool.name} has unexpected annotation key "${key}"`).toContain(key);
      }
    });
  });

  it('read-only tools should not be marked destructive', () => {
    getTools().forEach(tool => {
      if (tool.annotations?.readOnlyHint) {
        expect(
          tool.annotations.destructiveHint,
          `Tool ${tool.name} is readOnly but also destructive`
        ).toBe(false);
      }
    });
  });

  it('required fields should reference existing properties', () => {
    getTools().forEach(tool => {
      if (tool.inputSchema.required) {
        tool.inputSchema.required.forEach(reqField => {
          expect(
            tool.inputSchema.properties[reqField],
            `Tool ${tool.name} has required field "${reqField}" not in properties`
          ).toBeDefined();
        });
      }
    });
  });

  it('should return null for unknown tools', async () => {
    const result = await handleTool('nonexistent_tool', {}, createMockAxlAPI());
    expect(result).toBeNull();
  });

  it('should return valid MCP tool response format', async () => {
    const result = await handleTool(
      'axl_execute',
      {
        cucm_host: 'example.local',
        cucm_username: 'user',
        cucm_password: 'pass',
        cucm_version: '14.0',
        operation: 'addPhone',
        data: {
          phone: {
            name: 'SEP001122334455',
            product: 'Cisco 8845',
            class: 'Phone',
            protocol: 'SIP',
            devicePoolName: 'Default',
          },
        },
      },
      createMockAxlAPI()
    );

    expect(result).not.toBeNull();
    expect(Array.isArray(result?.content)).toBe(true);
    expect(result?.content[0]).toHaveProperty('type', 'text');
    expect(result?.content[0]).toHaveProperty('text');
    expect(() => JSON.parse(result!.content[0]!.text)).not.toThrow();
  });
});
