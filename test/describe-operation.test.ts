import { describe, it, expect } from 'vitest';
import { handleTool } from '../src/tools/index';
import type { AxlAPIService } from '../src/services/axl/index';
import { AXL_OBJECT_OPERATIONS } from '../src/types/generated/axl-objects';
import { AXL_OPERATION_SCHEMAS } from '../src/types/generated/axl-operation-schemas';

const mockApi: AxlAPIService = {
  executeOperation: async () => ({ ok: true }),
} as unknown as AxlAPIService;

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('axl_describe_operation', () => {
  it('returns schema for addPhone with required fields', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'addPhone' }, mockApi);
    const data = parseResult(result);

    expect(data.operationName).toBe('addPhone');
    expect(data.verb).toBe('add');
    expect(data.object).toBe('Phone');
    expect(data.wsdlVersion).toBe('15.0');

    // phone container is required
    expect(data.fields.phone).toBeDefined();
    expect(data.fields.phone.type).toBe('object');
    expect(data.fields.phone.required).toBe(true);
    expect(data.fields.phone.typeName).toBe('XPhone');

    // nested required fields
    const phoneFields = data.fields.phone.fields;
    expect(phoneFields.name.required).toBe(true);
    expect(phoneFields.product.required).toBe(true);
    expect(phoneFields.protocol.required).toBe(true);
    expect(phoneFields.devicePoolName.required).toBe(true);

    // optional field
    expect(phoneFields.description.required).toBeUndefined();
    expect(phoneFields.callingSearchSpaceName.required).toBeUndefined();
  });

  it('addPhone includes enum values for protocol', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'addPhone' }, mockApi);
    const data = parseResult(result);
    const phoneFields = data.fields.phone.fields;

    // protocol should have inline enum (small)
    expect(phoneFields.protocol.enum).toBeDefined();
    expect(phoneFields.protocol.enum).toContain('SIP');
    expect(phoneFields.protocol.enum).toContain('SCCP');

    // product should reference large enum
    expect(phoneFields.product.enumType).toBe('XProduct');
  });

  it('addPhone includes default values', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'addPhone' }, mockApi);
    const data = parseResult(result);
    const phoneFields = data.fields.phone.fields;

    // protocolSide defaults to "User"
    expect(phoneFields.protocolSide.default).toBe('User');
  });

  it('returns schema for getPhone with name/uuid', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'getPhone' }, mockApi);
    const data = parseResult(result);

    expect(data.verb).toBe('get');
    expect(data.object).toBe('Phone');
    expect(data.fields.name).toBeDefined();
    expect(data.fields.uuid).toBeDefined();
    expect(data.fields.returnedTags).toBeDefined();
  });

  it('returns schema for listPhone with searchCriteria', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'listPhone' }, mockApi);
    const data = parseResult(result);

    expect(data.verb).toBe('list');
    expect(data.object).toBe('Phone');
    expect(data.fields.searchCriteria).toBeDefined();
    expect(data.fields.searchCriteria.type).toBe('object');
    expect(data.fields.searchCriteria.fields).toBeDefined();
    expect(data.fields.searchCriteria.fields.name).toBeDefined();
    expect(data.fields.returnedTags).toBeDefined();
  });

  it('returns schema for removePhone', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'removePhone' }, mockApi);
    const data = parseResult(result);

    expect(data.verb).toBe('remove');
    expect(data.object).toBe('Phone');
    expect(data.fields.name).toBeDefined();
    expect(data.fields.uuid).toBeDefined();
  });

  it('returns schema for addUser', async () => {
    const result = await handleTool('axl_describe_operation', { operationName: 'addUser' }, mockApi);
    const data = parseResult(result);

    expect(data.verb).toBe('add');
    expect(data.object).toBe('User');
    expect(data.fields.user).toBeDefined();
    expect(data.fields.user.fields.lastName.required).toBe(true);
  });

  it('throws for unknown operation', async () => {
    await expect(
      handleTool('axl_describe_operation', { operationName: 'fakeOperation' }, mockApi)
    ).rejects.toThrow('No schema for "fakeOperation"');
  });

  it('throws when operation is missing', async () => {
    await expect(
      handleTool('axl_describe_operation', {}, mockApi)
    ).rejects.toThrow();
  });

  it('all mapped operations have schema entries', () => {
    const missing: string[] = [];
    let total = 0;
    for (const [, ops] of Object.entries(AXL_OBJECT_OPERATIONS) as Array<[string, Record<string, string>]>) {
      for (const [, opName] of Object.entries(ops)) {
        total++;
        if (!AXL_OPERATION_SCHEMAS[opName]) missing.push(opName);
      }
    }
    expect(missing).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(940);
  });

  it('schemas have correct verb and object', () => {
    for (const [objectName, ops] of Object.entries(AXL_OBJECT_OPERATIONS) as Array<[string, Record<string, string>]>) {
      for (const [verb, opName] of Object.entries(ops)) {
        const schema = AXL_OPERATION_SCHEMAS[opName];
        if (!schema) continue;
        expect(schema.verb).toBe(verb);
        expect(schema.object).toBe(objectName);
      }
    }
  });
});
