import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeConfig } from './helpers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('history and automation routes', () => {
  it.each([
    ['UTC Z', '2026-09-15T05:40:00Z', '2026-09-15T05:45:00Z'],
    ['encoded positive offset', '2026-09-15T07:40:00%2B02:00', '2026-09-15T07:45:00%2B02:00'],
    ['raw positive offset', '2026-09-15T07:40:00+02:00', '2026-09-15T07:45:00+02:00'],
    ['zero offset', '2026-09-15T05:40:00+00:00', '2026-09-15T05:45:00+00:00'],
    ['negative offset', '2026-09-15T00:10:00-05:30', '2026-09-15T00:15:00-05:30'],
  ])('accepts %s timestamps through the literal inject URL', async (_label, start, end) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([[]]));
    const config = makeConfig({ allowedDomains: new Set(['sensor']) });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/entities/sensor.energy/history?start_time=${start}&end_time=${end}`,
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      start_time: '2026-09-15T05:40:00.000Z',
      end_time: '2026-09-15T05:45:00.000Z',
    });
    await app.close();
  });

  it('accepts positive offsets serialized by URLSearchParams', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([[]]));
    const config = makeConfig({ allowedDomains: new Set(['sensor']) });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const query = new URLSearchParams({
      start_time: '2026-09-15T07:40:00+02:00',
      end_time: '2026-09-15T07:45:00+02:00',
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/entities/sensor.energy/history?${query.toString()}`,
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });

    expect(query.toString()).toContain('%2B02%3A00');
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it.each(['not-a-date', '2026-09-15 07:40:00 02:00', 'prefix 2026-09-15T07:40:00 02:00'])(
    'rejects invalid date-time %s without broad space replacement',
    async (start) => {
      const fetchMock = vi.fn<typeof fetch>();
      const config = makeConfig({ allowedDomains: new Set(['sensor']) });
      const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/entities/sensor.energy/history?start_time=${encodeURIComponent(start)}`,
        headers: { authorization: `Bearer ${config.gatewayApiKey}` },
      });

      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('returns minimal bounded history only for an allowed entity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([
        [
          { state: '0.12', last_changed: '2026-08-01T00:00:00+00:00', attributes: { secret: 'x' } },
          { state: '0.15', last_changed: '2026-08-01T01:00:00+00:00' },
        ],
      ]),
    );
    const config = makeConfig({
      allowedDomains: new Set(['sensor']),
      allowedEntities: new Set(['sensor.fridge_energy']),
    });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/sensor.fridge_energy/history?start_time=2026-08-01T00:00:00Z&end_time=2026-08-02T00:00:00Z',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      entity_id: 'sensor.fridge_energy',
      start_time: '2026-08-01T00:00:00.000Z',
      end_time: '2026-08-02T00:00:00.000Z',
      total_points: 2,
      returned_points: 2,
      sampled: false,
      points: [
        { state: '0.12', last_changed: '2026-08-01T00:00:00+00:00' },
        { state: '0.15', last_changed: '2026-08-01T01:00:00+00:00' },
      ],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/history/period/');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('filter_entity_id=sensor.fridge_energy');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('minimal_response=');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('no_attributes=');
    await app.close();
  });

  it('rejects disallowed or excessive history before contacting Home Assistant', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const config = makeConfig({
      allowedDomains: new Set(['sensor']),
      allowedEntities: new Set(['sensor.fridge_energy']),
    });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const headers = { authorization: `Bearer ${config.gatewayApiKey}` };

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/sensor.other/history?start_time=2026-08-01T00:00:00Z',
      headers,
    });
    expect(denied.statusCode).toBe(403);

    const tooLong = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/sensor.fridge_energy/history?start_time=2026-08-01T00:00:00Z&end_time=2026-09-02T00:00:00Z',
      headers,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns allowed automation configuration with sensitive values redacted', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/states/automation.fridge_schedule')) {
        return jsonResponse({
          entity_id: 'automation.fridge_schedule',
          state: 'on',
          attributes: { id: 'fridge-schedule', friendly_name: 'Fridge schedule' },
          last_changed: '2026-08-01T00:00:00+00:00',
          last_updated: '2026-08-01T00:00:00+00:00',
        });
      }
      return jsonResponse({
        alias: 'Fridge schedule',
        trigger: [{ platform: 'time', at: '23:00:00' }],
        action: [{ service: 'switch.turn_off', target: { entity_id: 'switch.fridge' } }],
        webhook_id: 'private-webhook',
        variables: { api_key: 'private-key' },
      });
    });
    const config = makeConfig({
      allowedDomains: new Set(['automation']),
      allowedEntities: new Set(['automation.fridge_schedule']),
    });
    const app = await buildApp({ config, fetchImpl: fetchMock, logger: false });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/automations/automation.fridge_schedule',
      headers: { authorization: `Bearer ${config.gatewayApiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entity_id: 'automation.fridge_schedule',
      friendly_name: 'Fridge schedule',
      state: 'on',
      automation: {
        alias: 'Fridge schedule',
        webhook_id: '[REDACTED]',
        variables: { api_key: '[REDACTED]' },
      },
    });
    expect(response.body).not.toContain('private-webhook');
    expect(response.body).not.toContain('private-key');
    await app.close();
  });
});
