import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDiagnosticsServer } from '../ha-chatgpt-diagnostics/server.mjs';
import { makeConfig, sampleStates, TEST_GATEWAY_KEY } from './helpers.js';

const DIAGNOSTICS_TOKEN = 'd'.repeat(64);

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

describe('real HTTP integration', () => {
  it.each([
    ['UTC Z', '2026-09-15T05:40:00Z', '2026-09-15T05:45:00Z'],
    ['encoded positive offset', '2026-09-15T07:40:00%2B02:00', '2026-09-15T07:45:00%2B02:00'],
    ['raw positive offset', '2026-09-15T07:40:00+02:00', '2026-09-15T07:45:00+02:00'],
    ['zero offset', '2026-09-15T05:40:00+00:00', '2026-09-15T05:45:00+00:00'],
    ['negative offset', '2026-09-15T00:10:00-05:30', '2026-09-15T00:15:00-05:30'],
  ])('accepts %s timestamps over a TCP socket', async (_label, start, end) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([[]]));
    const config = makeConfig({ allowedDomains: new Set(['sensor']) });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(
        `${baseUrl}/api/v1/entities/sensor.energy/history?start_time=${start}&end_time=${end}`,
        { headers: { authorization: `Bearer ${config.gatewayApiKey}` } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        start_time: '2026-09-15T05:40:00.000Z',
        end_time: '2026-09-15T05:45:00.000Z',
      });
    } finally {
      await app.close();
    }
  });

  it('keeps failed-auth and authenticated quotas independent over HTTP', async () => {
    const lines: string[] = [];
    const config = makeConfig({
      auditLogEnabled: true,
      auditHmacKey: 'a'.repeat(64),
      rateLimitMax: 2,
    });
    const app = await buildApp({
      config,
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(sampleStates)),
      logger: auditLogger(lines),
    });

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
      const request = (token: string) =>
        fetch(`${baseUrl}/api/v1/entities`, {
          headers: { authorization: `Bearer ${token}` },
        });

      expect((await request('invalid-token')).status).toBe(401);
      expect((await request('invalid-token')).status).toBe(401);
      expect((await request('invalid-token')).status).toBe(429);
      expect((await request(config.gatewayApiKey)).status).toBe(200);
      expect((await request(config.gatewayApiKey)).status).toBe(200);
      expect((await request(config.gatewayApiKey)).status).toBe(429);
    } finally {
      await app.close();
    }

    const events = auditEvents(lines);
    expect(events.map((event) => event.auth_outcome)).toEqual([
      'invalid',
      'invalid',
      'invalid',
      'authenticated',
      'authenticated',
      'authenticated',
    ]);
    expect(
      events.map(
        (event) => (event.rate_limits as Array<Record<string, unknown>>)[0]?.rate_limit_scope,
      ),
    ).toEqual([
      'gateway_pre_auth',
      'gateway_pre_auth',
      'gateway_pre_auth',
      'gateway_authenticated',
      'gateway_authenticated',
      'gateway_authenticated',
    ]);
    expect(JSON.stringify(events)).not.toContain('invalid-token');
    expect(JSON.stringify(events)).not.toContain(TEST_GATEWAY_KEY);
  });

  it('correlates and sanitizes a gateway-to-companion request end to end', async () => {
    const gatewayLines: string[] = [];
    const companionLogger = vi.fn();
    const sensitiveLogLine = 'ERROR private-core-detail';
    const companion = createDiagnosticsServer({
      diagnosticsToken: DIAGNOSTICS_TOKEN,
      supervisorToken: 'supervisor-test-token',
      fetchImpl: vi.fn().mockResolvedValue(new Response(sensitiveLogLine, { status: 200 })),
      logger: companionLogger,
    });

    await new Promise<void>((resolve) => companion.listen(0, '127.0.0.1', resolve));
    const companionPort = (companion.address() as AddressInfo).port;
    const config = makeConfig({
      errorLogsEnabled: true,
      diagnosticsAddonUrl: `http://127.0.0.1:${companionPort}`,
      diagnosticsAddonToken: DIAGNOSTICS_TOKEN,
      auditLogEnabled: true,
      auditHmacKey: 'b'.repeat(64),
    });
    const app = await buildApp({ config, fetchImpl: fetch, logger: auditLogger(gatewayLines) });

    try {
      const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${baseUrl}/api/v1/logs/errors?lines=10`, {
        headers: { authorization: `Bearer ${config.gatewayApiKey}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        source: 'home_assistant_core',
        entries: [sensitiveLogLine],
      });

      const [gatewayEvent] = auditEvents(gatewayLines);
      const companionEvent = companionLogger.mock.calls.find(
        (call) => call[1] === 'diagnostics_request_completed',
      )?.[2] as Record<string, unknown>;
      expect(response.headers.get('x-request-id')).toBe(gatewayEvent?.request_id);
      expect(companionEvent.request_id).toBe(gatewayEvent?.request_id);
      expect(companionEvent.auth_outcome).toBe('authenticated');

      const serializedAudit = JSON.stringify({ gatewayLines, calls: companionLogger.mock.calls });
      for (const forbidden of [
        sensitiveLogLine,
        TEST_GATEWAY_KEY,
        DIAGNOSTICS_TOKEN,
        'supervisor-test-token',
        'authorization',
      ]) {
        expect(serializedAudit).not.toContain(forbidden);
      }
    } finally {
      await app.close();
      await new Promise<void>((resolve) => companion.close(() => resolve()));
    }
  });
});
