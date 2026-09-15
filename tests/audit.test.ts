import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryRateLimiter } from '../src/security/rate-limit.js';
import { makeConfig, sampleStates, TEST_GATEWAY_KEY } from './helpers.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function auditLogger(lines: string[]) {
  return {
    level: 'info',
    stream: { write: (line: string) => lines.push(line) },
  };
}

function auditEvents(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === 'request_completed');
}

describe('privacy-preserving request audit', () => {
  it('distinguishes auth outcomes and credential IDs without logging secrets or bodies', async () => {
    const lines: string[] = [];
    const invalidToken = 'invalid-token-that-must-not-appear';
    const stateValue = 'sensitive-ha-state-value';
    const readKey = '1'.repeat(64);
    const writeKey = '2'.repeat(64);
    const config = makeConfig({
      auditLogEnabled: true,
      auditHmacKey: '3'.repeat(64),
      gatewayCredentials: [
        { id: 'read', key: readKey, scopes: new Set(['read']) },
        { id: 'write', key: writeKey, scopes: new Set(['read', 'write']) },
      ],
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([{ ...sampleStates[0], state: stateValue }]));
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: auditLogger(lines) });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/entities' });
    await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      headers: { authorization: 'Basic malformed-value' },
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      headers: { authorization: `Bearer ${invalidToken}` },
    });
    for (const key of [readKey, writeKey]) {
      await app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: `Bearer ${key}`, 'user-agent': 'audit\u0007agent' },
      });
    }
    await app.close();

    const events = auditEvents(lines);
    expect(events.map((event) => event.auth_outcome)).toEqual([
      'missing',
      'malformed',
      'invalid',
      'authenticated',
      'authenticated',
    ]);
    expect(events.slice(3).map((event) => event.credential_id)).toEqual(['read', 'write']);
    expect(events[3]?.user_agent).toBe('auditagent');
    expect(events.every((event) => typeof event.request_id === 'string')).toBe(true);
    expect(events.every((event) => /^[0-9a-f-]{36}$/.test(String(event.request_id)))).toBe(true);
    expect(
      events.every((event) => event.client_ip === undefined && event.peer_ip === undefined),
    ).toBe(true);
    expect(missing.headers['x-request-id']).toBe(events[0]?.request_id);
    const serialized = JSON.stringify(events);
    for (const forbidden of [
      invalidToken,
      readKey,
      writeKey,
      TEST_GATEWAY_KEY,
      '3'.repeat(64),
      'authorization',
      stateValue,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('records allowed and blocked rate-limit decisions with retry metadata', async () => {
    const lines: string[] = [];
    const config = makeConfig({
      auditLogEnabled: true,
      auditHmacKey: '6'.repeat(64),
      rateLimitMax: 1,
    });
    const app = await buildApp({
      config,
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(sampleStates)),
      logger: auditLogger(lines),
    });
    const request = () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        headers: { authorization: `Bearer ${config.gatewayApiKey}` },
      });
    expect((await request()).statusCode).toBe(200);
    const blocked = await request();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    await app.close();

    const rates = auditEvents(lines).map(
      (event) => event.rate_limits as Array<Record<string, unknown>>,
    );
    expect(rates[0]?.[0]).toMatchObject({
      rate_limit_scope: 'gateway_authenticated',
      rate_limit_decision: 'allowed',
      rate_limit_count: 1,
      rate_limit_remaining: 0,
    });
    expect(rates[1]?.[0]).toMatchObject({
      rate_limit_scope: 'gateway_authenticated',
      rate_limit_decision: 'blocked',
      rate_limit_count: 2,
      rate_limit_remaining: 0,
    });
  });

  it('records trusted proxy use and distinct clients behind one peer', async () => {
    const lines: string[] = [];
    const config = makeConfig({
      auditLogEnabled: true,
      auditHmacKey: '4'.repeat(64),
      trustedProxies: ['127.0.0.1'],
    });
    const app = await buildApp({
      config,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates)),
      logger: auditLogger(lines),
    });
    for (const client of ['203.0.113.10', '203.0.113.11']) {
      await app.inject({
        method: 'GET',
        url: '/api/v1/entities',
        remoteAddress: '127.0.0.1',
        headers: {
          authorization: `Bearer ${config.gatewayApiKey}`,
          'x-forwarded-for': client,
        },
      });
    }
    await app.close();

    const events = auditEvents(lines);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.trusted_proxy_used === true)).toBe(true);
    expect(events[0]?.peer_fingerprint).toBe(events[1]?.peer_fingerprint);
    expect(events[0]?.client_fingerprint).not.toBe(events[1]?.client_fingerprint);
  });

  it('does not trust forwarded addresses from an untrusted peer', async () => {
    const lines: string[] = [];
    const config = makeConfig({ auditLogEnabled: true, auditHmacKey: '5'.repeat(64) });
    const app = await buildApp({
      config,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(sampleStates)),
      logger: auditLogger(lines),
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/entities',
      remoteAddress: '198.51.100.50',
      headers: {
        authorization: `Bearer ${config.gatewayApiKey}`,
        'x-forwarded-for': '203.0.113.99',
      },
    });
    await app.close();

    const [event] = auditEvents(lines);
    expect(event?.trusted_proxy_used).toBe(false);
    expect(event?.client_fingerprint).toBe(event?.peer_fingerprint);
  });
});

describe('bounded process-local rate limiter', () => {
  it('resets expired buckets and bounds map growth', () => {
    const limiter = new InMemoryRateLimiter(1, 1_000, 3);
    expect(limiter.consume('a', 0).decision).toBe('allowed');
    expect(limiter.consume('a', 1).decision).toBe('blocked');
    expect(limiter.consume('a', 1_000)).toMatchObject({
      decision: 'allowed',
      count: 1,
      remaining: 0,
    });
    limiter.consume('b', 1_000);
    limiter.consume('c', 1_000);
    limiter.consume('d', 1_000);
    expect(limiter.size).toBe(3);
  });
});
