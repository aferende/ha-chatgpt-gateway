import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import { registerLogbookRoutes } from './logbook.js';

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 8787,
    homeAssistantUrl: 'http://homeassistant.local:8123',
    homeAssistantToken: 'test-token',
    gatewayApiKey: 'a'.repeat(64),
    gatewayCredentials: [],
    allowedDomains: new Set(['sensor', 'automation']),
    allowedEntities: new Set<string>(),
    readOnly: true,
    logbookEnabled: true,
    errorLogsEnabled: false,
    logLevel: 'silent',
    homeAssistantTimeoutMs: 10_000,
    homeAssistantServiceTimeoutMs: 30_000,
    asyncServiceDispatchEnabled: false,
    asyncServiceDomains: new Set<string>(),
    homeAssistantAsyncServiceTimeoutMs: 1_800_000,
    asyncServiceMaxConcurrent: 2,
    adminActionsEnabled: false,
    adminAllowedActions: new Set<string>(),
    rateLimitMax: 120,
    rateLimitWindowMs: 60_000,
    serviceRateLimitMax: 20,
    serviceRateLimitWindowMs: 60_000,
    trustedProxies: [],
    ...overrides,
  };
}

function makeClient(entries: unknown[]): HomeAssistantClient {
  return {
    getLogbook: vi.fn().mockResolvedValue(entries),
  } as unknown as HomeAssistantClient;
}

describe('logbook routes', () => {
  it('does not register the route when logbook access is disabled', async () => {
    const app = Fastify();
    await registerLogbookRoutes(app, makeConfig({ logbookEnabled: false }), makeClient([]));

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-02T18:00:00Z',
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('filters disallowed entities and omits state by default', async () => {
    const app = Fastify();
    const client = makeClient([
      {
        entity_id: 'sensor.allowed',
        state: '10.2.100.125',
        name: 'Allowed sensor',
        when: '2026-09-02T18:00:00Z',
      },
      {
        entity_id: 'light.blocked_domain',
        state: 'on',
        name: 'Blocked light',
        when: '2026-09-02T18:00:01Z',
      },
    ]);
    await registerLogbookRoutes(app, makeConfig(), client);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-02T18:00:00Z&end_time=2026-09-02T19:00:00Z&limit=20',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.include_state).toBe(false);
    expect(body.returned_entries).toBe(1);
    expect(body.entries).toEqual([
      {
        entity_id: 'sensor.allowed',
        name: 'Allowed sensor',
        when: '2026-09-02T18:00:00Z',
      },
    ]);
    await app.close();
  });

  it('includes state only when explicitly requested', async () => {
    const app = Fastify();
    await registerLogbookRoutes(
      app,
      makeConfig(),
      makeClient([
        {
          entity_id: 'sensor.allowed',
          state: '42',
          name: 'Allowed sensor',
          when: '2026-09-02T18:00:00Z',
        },
      ]),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-02T18:00:00Z&end_time=2026-09-02T19:00:00Z&include_state=true',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.include_state).toBe(true);
    expect(body.entries[0].state).toBe('42');
    await app.close();
  });

  it('rejects disallowed explicit entities', async () => {
    const app = Fastify();
    await registerLogbookRoutes(
      app,
      makeConfig({ allowedEntities: new Set(['sensor.allowed']) }),
      makeClient([]),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-02T18:00:00Z&end_time=2026-09-02T19:00:00Z&entity_id=sensor.blocked',
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('limits unscoped requests to 24 hours but allows entity-scoped requests up to seven days', async () => {
    const app = Fastify();
    await registerLogbookRoutes(app, makeConfig(), makeClient([]));

    const unscoped = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-01T00:00:00Z&end_time=2026-09-02T01:00:00Z',
    });
    expect(unscoped.statusCode).toBe(400);

    const scoped = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-08-27T00:00:00Z&end_time=2026-09-02T00:00:00Z&entity_id=sensor.allowed',
    });
    expect(scoped.statusCode).toBe(200);

    await app.close();
  });

  it('rejects entity-scoped ranges longer than seven days and limits above 500', async () => {
    const app = Fastify();
    await registerLogbookRoutes(app, makeConfig(), makeClient([]));

    const longRange = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-08-01T00:00:00Z&end_time=2026-09-02T00:00:00Z&entity_id=sensor.allowed',
    });
    expect(longRange.statusCode).toBe(400);

    const excessiveLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/logbook?start_time=2026-09-02T18:00:00Z&end_time=2026-09-02T19:00:00Z&limit=501',
    });
    expect(excessiveLimit.statusCode).toBe(400);

    await app.close();
  });
});
