import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GatewayConfig } from '../src/config/env.js';
import { makeConfig, sampleStates } from './helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('entity routes', () => {
  it('requires the gateway API key', async () => {
    const app = await buildApp({ config: makeConfig(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/entities' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an incorrect gateway API key', async () => {
    const app = await buildApp({ config: makeConfig(), logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      headers: { authorization: 'Bearer definitely-not-the-right-key' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rate limits repeated invalid Bearer tokens before authentication', async () => {
    const config = makeConfig({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const app = await buildApp({ config, logger: false });
    const request = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: 'Bearer definitely-not-the-right-key' },
      });

    expect((await request()).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(429);
    expect((await request()).statusCode).toBe(429);
    await app.close();
  });

  it('ignores forwarded addresses when no reverse proxy is trusted', async () => {
    const config = makeConfig({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const app = await buildApp({ config, logger: false });
    const request = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        remoteAddress: '198.51.100.50',
        headers: {
          authorization: 'Bearer definitely-not-the-right-key',
          'x-forwarded-for': forwardedFor,
        },
      });

    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.11')).statusCode).toBe(401);
    expect((await request('203.0.113.12')).statusCode).toBe(429);
    await app.close();
  });

  it('keeps client buckets separate behind a trusted localhost proxy', async () => {
    const config = {
      ...makeConfig({ rateLimitMax: 2, rateLimitWindowMs: 60_000 }),
      trustedProxies: ['127.0.0.1'],
    } as GatewayConfig;
    const app = await buildApp({ config, logger: false });
    const request = (clientIp: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        remoteAddress: '127.0.0.1',
        headers: {
          authorization: 'Bearer definitely-not-the-right-key',
          'x-forwarded-for': clientIp,
        },
      });

    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.10')).statusCode).toBe(429);
    expect((await request('203.0.113.11')).statusCode).toBe(401);
    await app.close();
  });

  it('ignores forwarded addresses from a peer outside the trusted proxy list', async () => {
    const config = {
      ...makeConfig({ rateLimitMax: 1, rateLimitWindowMs: 60_000 }),
      trustedProxies: ['127.0.0.1'],
    } as GatewayConfig;
    const app = await buildApp({ config, logger: false });
    const request = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        remoteAddress: '198.51.100.50',
        headers: {
          authorization: 'Bearer definitely-not-the-right-key',
          'x-forwarded-for': forwardedFor,
        },
      });

    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.99')).statusCode).toBe(429);
    await app.close();
  });

  it('resolves a forwarding chain only through each explicitly trusted proxy', async () => {
    const config = {
      ...makeConfig({ rateLimitMax: 1, rateLimitWindowMs: 60_000 }),
      trustedProxies: ['127.0.0.1', '10.0.0.2'],
    } as GatewayConfig;
    const app = await buildApp({ config, logger: false });
    const request = (clientIp: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        remoteAddress: '127.0.0.1',
        headers: {
          authorization: 'Bearer definitely-not-the-right-key',
          'x-forwarded-for': `${clientIp}, 10.0.0.2`,
        },
      });

    expect((await request('203.0.113.10')).statusCode).toBe(401);
    expect((await request('203.0.113.10')).statusCode).toBe(429);
    expect((await request('203.0.113.11')).statusCode).toBe(401);
    await app.close();
  });

  it('does not let failed authentication consume authenticated quota', async () => {
    const config = makeConfig({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(sampleStates));
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });

    expect((await app.inject({ method: 'GET', url: '/api/v1/entities' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/entities',
          headers: { authorization: 'Basic not-a-bearer-token' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/entities',
          headers: { authorization: 'Bearer definitely-not-the-right-key' },
        })
      ).statusCode,
    ).toBe(401);
    const validRequest = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: `Bearer ${config.gatewayApiKey}` },
      });
    expect((await validRequest()).statusCode).toBe(200);
    expect((await validRequest()).statusCode).toBe(200);
    expect((await validRequest()).statusCode).toBe(200);
    const blocked = await validRequest();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('rate limits authenticated requests after the configured limit', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates));
    const config = makeConfig({ rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const request = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: `Bearer ${config.gatewayApiKey}` },
      });

    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    await app.close();
  });

  it('keeps authenticated credential IDs in separate buckets', async () => {
    const readKey = '1'.repeat(64);
    const writeKey = '2'.repeat(64);
    const config = makeConfig({
      rateLimitMax: 1,
      gatewayCredentials: [
        { id: 'read', key: readKey, scopes: new Set(['read']) },
        { id: 'write', key: writeKey, scopes: new Set(['read', 'write']) },
      ],
    });
    const app = await buildApp({
      config,
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(sampleStates)),
      logger: false,
    });
    const request = (key: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await request(readKey)).statusCode).toBe(200);
    expect((await request(readKey)).statusCode).toBe(429);
    expect((await request(writeKey)).statusCode).toBe(200);
    await app.close();
  });

  it('filters out disallowed domains', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates));
    const config = makeConfig();
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entities.map((item: { entity_id: string }) => item.entity_id)).toEqual([
      'light.living_room',
      'switch.coffee_machine',
    ]);
    expect(response.json().entities[0].friendly_name).toBe('Living room');
    await app.close();
  });

  it('supports semantic entity filters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates));
    const config = makeConfig();
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities?domain=light&name=living&state=on',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entities).toHaveLength(1);
    await app.close();
  });

  it('honors an explicit entity allowlist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates));
    const config = makeConfig({ allowedEntities: new Set(['light.living_room']) });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });
    expect(response.json().entities).toHaveLength(1);
    expect(response.json().entities[0].entity_id).toBe('light.living_room');
    await app.close();
  });

  it('rejects access to a disallowed entity before contacting Home Assistant', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const config = makeConfig();
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/lock.front_door',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
