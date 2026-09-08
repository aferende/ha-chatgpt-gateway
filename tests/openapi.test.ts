import { describe, expect, it } from 'vitest';

import { buildOpenApiSchema } from '../src/openapi/action-schema.js';

describe('OpenAPI action schema', () => {
  it('keeps operation descriptions within the ChatGPT Actions limit', () => {
    const schema = buildOpenApiSchema('https://example.com', {
      logbookEnabled: true,
      errorLogsEnabled: true,
    });

    for (const pathItem of Object.values(schema.paths)) {
      for (const operation of Object.values(pathItem)) {
        if ('description' in operation && typeof operation.description === 'string') {
          expect(operation.description.length).toBeLessThanOrEqual(300);
        }
      }
    }
  });
});
