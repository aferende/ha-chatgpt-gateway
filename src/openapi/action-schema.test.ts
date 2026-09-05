import { describe, expect, it } from 'vitest';
import { buildOpenApiSchema } from './action-schema.js';

describe('diagnostic OpenAPI feature flags', () => {
  it('does not advertise logbook by default', () => {
    const schema = buildOpenApiSchema('https://gateway.example.com');
    expect(schema.paths).not.toHaveProperty('/api/v1/logbook');
    expect(schema.paths).not.toHaveProperty('/api/v1/logs/errors');
  });

  it('advertises bounded error logs only when explicitly enabled', () => {
    const schema = buildOpenApiSchema('https://gateway.example.com', {
      errorLogsEnabled: true,
    });
    const route = schema.paths['/api/v1/logs/errors'];
    expect(route).toBeDefined();
    const parameters = route && 'get' in route ? route.get.parameters : [];
    expect(parameters?.find((parameter) => parameter.name === 'lines')?.schema).toMatchObject({
      minimum: 1,
      maximum: 500,
      default: 100,
    });
  });

  it('advertises logbook only when explicitly enabled', () => {
    const schema = buildOpenApiSchema('https://gateway.example.com', {
      logbookEnabled: true,
    });
    expect(schema.paths).toHaveProperty('/api/v1/logbook');

    const logbook = schema.paths['/api/v1/logbook'];
    expect(logbook).toBeDefined();
    const parameters = logbook && 'get' in logbook ? logbook.get.parameters : [];
    const includeState = parameters?.find((parameter) => parameter.name === 'include_state');
    expect(includeState?.schema).toMatchObject({ type: 'boolean', default: false });
    expect(logbook && 'get' in logbook ? logbook.get.description : '').toContain('24 hours');
    expect(logbook && 'get' in logbook ? logbook.get.description : '').toContain('7 days');
  });
});
