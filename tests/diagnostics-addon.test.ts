import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticsServer,
  fetchCoreErrorLogs,
  formatLogEvent,
} from '../ha-chatgpt-diagnostics/server.mjs';

const DIAGNOSTICS_TOKEN = 'a'.repeat(64);
const servers: ReturnType<typeof createDiagnosticsServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startServer(logText = '2026-09-04 ERROR Test failure') {
  const fetchImpl = vi.fn().mockImplementation(async () => new Response(logText, { status: 200 }));
  const logger = vi.fn();
  const server = createDiagnosticsServer({
    diagnosticsToken: DIAGNOSTICS_TOKEN,
    supervisorToken: 'supervisor-test-token',
    fetchImpl,
    logger,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, fetchImpl, logger };
}

function authorizedHeaders() {
  return { authorization: `Bearer ${DIAGNOSTICS_TOKEN}` };
}

async function fetchLogResult(logText: string, lines = 100) {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(logText, { status: 200 }));
  return fetchCoreErrorLogs({ lines, supervisorToken: 'supervisor-test-token', fetchImpl });
}

describe('diagnostics companion', () => {
  it('exposes health without authentication', async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it.each([
    ['without a token', undefined],
    ['with a wrong token', { authorization: `Bearer ${'b'.repeat(64)}` }],
  ])('returns 401 %s', async (_label, headers) => {
    const { baseUrl, logger } = await startServer();
    const response = await fetch(`${baseUrl}/api/v1/logs/errors`, { headers });
    expect(response.status).toBe(401);
    expect(logger).toHaveBeenCalledWith('warning', 'authentication_failed');
    expect(JSON.stringify(logger.mock.calls)).not.toContain(DIAGNOSTICS_TOKEN);
  });

  it('returns bounded warning and error records with a correct token', async () => {
    const { baseUrl, fetchImpl, logger } = await startServer(
      ['INFO startup', 'WARNING first issue', 'ERROR second issue'].join('\n'),
    );
    const response = await fetch(`${baseUrl}/api/v1/logs/errors?lines=25`, {
      headers: authorizedHeaders(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      source: 'home_assistant_core',
      requested_lines: 25,
      returned_lines: 2,
      entries: ['WARNING first issue', 'ERROR second issue'],
    });
    const supervisorUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(supervisorUrl.pathname).toBe('/core/logs');
    expect(supervisorUrl.searchParams.get('lines')).toBe('25');
    expect(logger).toHaveBeenCalledWith('info', 'core_logs_returned', {
      requested_lines: 25,
      returned_lines: 2,
    });
  });

  it('formats readable English log events with an ISO-8601 UTC timestamp', () => {
    const line = formatLogEvent(
      'info',
      'listening',
      { host: '0.0.0.0', port: 8099 },
      new Date('2026-09-04T19:00:00.000Z'),
    );
    expect(line).toBe(
      '2026-09-04T19:00:00.000Z INFO Diagnostics API listening host=0.0.0.0 port=8099',
    );
    expect(line).not.toContain(DIAGNOSTICS_TOKEN);
  });

  it.each(['0', '501', '1;cat /etc/passwd', '../secrets'])(
    'rejects invalid lines=%s',
    async (lines) => {
      const { baseUrl, fetchImpl } = await startServer();
      const response = await fetch(
        `${baseUrl}/api/v1/logs/errors?lines=${encodeURIComponent(lines)}`,
        { headers: authorizedHeaders() },
      );
      expect(response.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects source selection and arbitrary paths', async () => {
    const { baseUrl, fetchImpl } = await startServer();
    const sourceResponse = await fetch(`${baseUrl}/api/v1/logs/errors?source=host`, {
      headers: authorizedHeaders(),
    });
    const pathResponse = await fetch(`${baseUrl}/api/v1/logs/../../host/logs`, {
      headers: authorizedHeaders(),
    });
    expect(sourceResponse.status).toBe(400);
    expect(pathResponse.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts secrets in traceback continuation lines', async () => {
    const secret = 'secret-value-that-must-not-leak';
    const { baseUrl } = await startServer(
      [
        '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Request failed',
        'Traceback (most recent call last):',
        `  Authorization: Bearer ${secret} url=https://user:pass@example.test token=${secret}`,
        'RuntimeError: request failed',
      ].join('\n'),
    );
    const response = await fetch(`${baseUrl}/api/v1/logs/errors?lines=10`, {
      headers: authorizedHeaders(),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain(secret);
    expect(body).not.toContain('user:pass');
    expect(body).toContain('[REDACTED]');
  });

  it('rate-limits repeated requests', async () => {
    const { baseUrl } = await startServer();
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${baseUrl}/api/v1/logs/errors?lines=1`, {
        headers: authorizedHeaders(),
      });
      expect(response.status).toBe(200);
    }
    const response = await fetch(`${baseUrl}/api/v1/logs/errors?lines=1`, {
      headers: authorizedHeaders(),
    });
    expect(response.status).toBe(429);
  });

  it('does not expose Supervisor errors or tokens', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('secret supervisor failure'));
    await startServer();
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const replacement = createDiagnosticsServer({
      diagnosticsToken: DIAGNOSTICS_TOKEN,
      supervisorToken: 'supervisor-test-token',
      fetchImpl,
      logger: vi.fn(),
    });
    servers.push(replacement);
    await new Promise<void>((resolve) => replacement.listen(0, '127.0.0.1', resolve));
    const port = (replacement.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/logs/errors`, {
      headers: authorizedHeaders(),
    });
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).not.toContain('secret supervisor failure');
    expect(body).not.toContain('supervisor-test-token');
  });
});

describe('Supervisor log fetch', () => {
  it('keeps a single error record', async () => {
    const result = await fetchLogResult(
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Single failure',
    );
    expect(result.entries).toEqual([
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Single failure',
    ]);
  });

  it('keeps a multiline Python traceback with its error record', async () => {
    const lines = [
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Request failed',
      'Traceback (most recent call last):',
      '  File "/config/custom_components/test.py", line 10, in update',
      '    raise RuntimeError("failed")',
      'RuntimeError: failed',
    ];
    const result = await fetchLogResult(lines.join('\n'));
    expect(result.entries).toEqual(lines);
  });

  it('keeps warning continuation lines', async () => {
    const lines = [
      '2026-09-05 07:45:12.123 WARNING (MainThread) [test] Slow update',
      'Additional warning context',
      'Second context line',
    ];
    const result = await fetchLogResult(lines.join('\n'));
    expect(result.entries).toEqual(lines);
  });

  it('removes an unrelated info record', async () => {
    const result = await fetchLogResult(
      '2026-09-05 07:45:12.123 INFO (MainThread) [test] Normal startup',
    );
    expect(result.entries).toEqual([]);
  });

  it('stops an error block when a new info record begins', async () => {
    const result = await fetchLogResult(
      [
        '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Request failed',
        'Traceback (most recent call last):',
        'RuntimeError: failed',
        '2026-09-05 07:45:13.123 INFO (MainThread) [test] Recovered',
        'Unrelated info continuation',
      ].join('\n'),
    );
    expect(result.entries).toEqual([
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Request failed',
      'Traceback (most recent call last):',
      'RuntimeError: failed',
    ]);
  });

  it('keeps consecutive error records as separate complete blocks', async () => {
    const lines = [
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] First failure',
      'RuntimeError: first',
      '2026-09-05 07:45:13.123 CRITICAL (MainThread) [test] Second failure',
      'RuntimeError: second',
    ];
    const result = await fetchLogResult(lines.join('\n'));
    expect(result.entries).toEqual(lines);
  });

  it('keeps the record header and newest context within the line bound', async () => {
    const lines = [
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Large traceback',
      ...Array.from({ length: 10 }, (_, index) => `traceback line ${index + 1}`),
    ];
    const result = await fetchLogResult(lines.join('\n'), 5);
    expect(result.entries).toEqual([lines[0], ...lines.slice(-4)]);
    expect(result.returned_lines).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('keeps the serialized response within the byte bound', async () => {
    const lines = [
      '2026-09-05 07:45:12.123 ERROR (MainThread) [test] Large traceback',
      ...Array.from({ length: 499 }, () => '"'.repeat(1_900)),
    ];
    const result = await fetchLogResult(lines.join('\n'), 500);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
    expect(result.entries.length).toBeLessThanOrEqual(500);
    expect(result.entries[0]).toBe(lines[0]);
    expect(result.truncated).toBe(true);
  });

  it('rejects an oversized Supervisor response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
    await expect(
      fetchCoreErrorLogs({ lines: 500, supervisorToken: 'test', fetchImpl }),
    ).rejects.toThrow('Supervisor response exceeded the size limit');
  });

  it('never supports a caller-selected source', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ERROR test', { status: 200 }));
    await fetchCoreErrorLogs({ lines: 1, supervisorToken: 'test', fetchImpl });
    const url = fetchImpl.mock.calls[0]?.[0] as URL;
    expect(url.origin).toBe('http://supervisor');
    expect(url.pathname).toBe('/core/logs');
  });
});
