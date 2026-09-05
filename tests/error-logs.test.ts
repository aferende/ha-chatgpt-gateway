import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GatewayConfig } from '../src/config/env.js';
import { TEST_GATEWAY_KEY, makeConfig } from './helpers.js';

const DIAGNOSTICS_TOKEN = 'd'.repeat(64);

function enabledConfig(overrides: Partial<GatewayConfig> = {}) {
  return makeConfig({
    errorLogsEnabled: true,
    diagnosticsAddonUrl: 'http://diagnostics.internal:8099',
    diagnosticsAddonToken: DIAGNOSTICS_TOKEN,
    ...overrides,
  });
}

function successfulFetch(entries = ['ERROR safe failure']) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        source: 'home_assistant_core',
        requested_lines: 100,
        returned_lines: entries.length,
        truncated: true,
        entries,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('gateway error log route', () => {
  it('is absent when disabled', async () => {
    const app = await buildApp({ config: makeConfig(), logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/errors',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('still requires gateway authentication', async () => {
    const app = await buildApp({
      config: enabledConfig(),
      fetchImpl: successfulFetch(),
      logger: false,
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/logs/errors' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('forwards a fixed request and redacts the companion response again', async () => {
    const secret = 'must-not-leak';
    const fetchImpl = successfulFetch([`ERROR password=${secret}`]);
    const app = await buildApp({ config: enabledConfig(), fetchImpl, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/errors',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(secret);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/logs/errors');
    expect(url.searchParams.get('lines')).toBe('100');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ authorization: `Bearer ${DIAGNOSTICS_TOKEN}` });
    await app.close();
  });

  it('rejects a companion response that exceeds the requested window', async () => {
    const app = await buildApp({
      config: enabledConfig(),
      fetchImpl: successfulFetch(['ERROR one', 'ERROR two']),
      logger: false,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/errors?lines=1',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it.each(['0', '501'])('rejects lines=%s before contacting the companion', async (lines) => {
    const fetchImpl = successfulFetch();
    const app = await buildApp({ config: enabledConfig(), fetchImpl, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/logs/errors?lines=${lines}`,
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 503 without internal details when the companion is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`failed with ${DIAGNOSTICS_TOKEN}`));
    const config = enabledConfig();
    const app = await buildApp({ config, fetchImpl, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/errors',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(DIAGNOSTICS_TOKEN);
    expect(response.body).not.toContain(config.diagnosticsAddonUrl ?? 'not-configured');
    await app.close();
  });

  it('does not expose tokens when companion authentication fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('invalid token', { status: 401 }));
    const app = await buildApp({ config: enabledConfig(), fetchImpl, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/logs/errors',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(DIAGNOSTICS_TOKEN);
    expect(response.body).not.toContain('invalid token');
    await app.close();
  });

  it('uses the existing protected-route rate limit', async () => {
    const app = await buildApp({
      config: enabledConfig({ rateLimitMax: 1 }),
      fetchImpl: successfulFetch(),
      logger: false,
    });
    const request = {
      method: 'GET' as const,
      url: '/api/v1/logs/errors',
      headers: { authorization: `Bearer ${TEST_GATEWAY_KEY}` },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(429);
    await app.close();
  });
});
