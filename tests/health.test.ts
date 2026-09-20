import { describe, expect, it } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.js';
import { makeConfig } from './helpers.js';

describe('health and OpenAPI', () => {
  it('exposes public health without authentication', async () => {
    const app = await buildApp({ config: makeConfig(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '0.6.0', readOnly: false });
    await app.close();
  });

  it('publishes a valid OpenAPI 3.1 schema without credentials', async () => {
    const app = await buildApp({ config: makeConfig(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toBe('3.1.0');
    expect(response.json().paths['/api/v1/services/call']).toBeDefined();
    expect(response.json().paths['/api/v1/services/batch']).toBeDefined();
    expect(response.json().paths['/api/v1/service-dispatches/{dispatchId}']).toBeDefined();
    expect(response.json().paths['/api/v1/admin/actions/call']).toBeDefined();
    expect(response.json().paths['/api/v1/services/{domain}/{service}']).toBeDefined();
    expect(response.json().paths['/api/v1/areas']).toBeDefined();
    expect(response.json().paths['/api/v1/entities/{entityId}/history']).toBeDefined();
    expect(response.json().paths['/api/v1/automations/{entityId}']).toBeDefined();
    expect(response.json().paths['/api/v1/entities/{entityId}'].get.parameters).toEqual([
      expect.objectContaining({ name: 'entityId', in: 'path', required: true }),
    ]);
    const serviceCall = response.json().components.schemas.ServiceCall;
    expect(serviceCall.required).toEqual(['domain', 'service', 'entity_id']);
    expect(serviceCall.properties.entity_id.type).toBe('array');
    expect(serviceCall.properties.data.type).toBe('object');
    expect(serviceCall.properties.data.additionalProperties).toBe(true);
    expect(serviceCall.properties.data_json.type).toBe('string');
    expect(response.json().components.schemas.AdminActionCall.required).toEqual([
      'domain',
      'service',
    ]);
    expect(JSON.stringify(serviceCall)).not.toContain('oneOf');
    expect(JSON.stringify(response.json())).not.toContain('HOME_ASSISTANT_TOKEN');
    expect(JSON.stringify(response.json())).not.toContain('ha-test-token');
    const descriptions = Object.values(
      response.json().paths as Record<string, Record<string, unknown>>,
    ).flatMap((pathItem) =>
      Object.values(pathItem).flatMap((operation) => {
        if (typeof operation !== 'object' || operation === null) {
          return [];
        }

        const description = (operation as Record<string, unknown>).description;
        return typeof description === 'string' ? [description] : [];
      }),
    );
    expect(descriptions).not.toHaveLength(0);
    expect(descriptions.every((description) => description.length <= 300)).toBe(true);
    await expect(SwaggerParser.validate(response.json())).resolves.toBeDefined();
    await app.close();
  });

  it('advertises the configured public URL for GPT Action imports', async () => {
    const app = await buildApp({
      config: makeConfig({ publicBaseUrl: 'https://gateway.example.com' }),
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.json().servers).toEqual([{ url: 'https://gateway.example.com' }]);
    await app.close();
  });
});
