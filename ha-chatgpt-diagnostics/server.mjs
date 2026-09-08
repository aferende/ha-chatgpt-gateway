/* global AbortSignal, fetch */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

const DEFAULT_LINES = 100;
const MAX_LINES = 500;
const MAX_SUPERVISOR_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 24_576;
const MAX_REQUESTS = 30;
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOG_RECORD_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+)?\[?(debug|info|notice|warning|warn|error|err|critical|fatal)\]?(?=\s|$)/i;
const ERROR_LEVELS = new Set(['warning', 'warn', 'error', 'err', 'critical', 'fatal']);
const APP_VERSION = process.env.APP_VERSION ?? 'development';

const SENSITIVE_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;}]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /(\/api\/webhook\/)[A-Za-z0-9._~-]+/gi,
  /([?&](?:access[_-]?token|api[_-]?key|password|secret|token)=)[^&#\s]+/gi,
];

export function formatLogEvent(level, event, fields = {}, timestamp = new Date()) {
  const messages = {
    startup_begin: `Diagnostics app started version=${fields.version}`,
    configuration_loaded: 'Configuration loaded',
    privileges_dropped: `Privileges dropped uid=${fields.uid} gid=${fields.gid}`,
    listening: `Diagnostics API listening host=${fields.host} port=${fields.port}`,
    core_logs_returned: `Core logs returned requested_lines=${fields.requested_lines} returned_lines=${fields.returned_lines}`,
    authentication_failed: 'Authentication failed',
    request_rate_limited: 'Request rate limited',
    supervisor_request_failed: 'Supervisor request failed',
    shutdown_requested: `Shutdown requested signal=${fields.signal}`,
    shutdown_complete: 'Shutdown complete',
    shutdown_failed: 'Shutdown failed',
    startup_failed: `Startup failed category=${fields.category}`,
  };
  return `${timestamp.toISOString()} ${level.toUpperCase()} ${messages[event] ?? event}`;
}

function logEvent(level, event, fields = {}) {
  const line = formatLogEvent(level, event, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.log(line);
}

export function redactSensitiveText(value) {
  return value
    .replace(SENSITIVE_TEXT_PATTERNS[0], 'Bearer [REDACTED]')
    .replace(SENSITIVE_TEXT_PATTERNS[1], '[REDACTED]')
    .replace(SENSITIVE_TEXT_PATTERNS[2], '[REDACTED]')
    .replace(SENSITIVE_TEXT_PATTERNS[3], '$1[REDACTED]@')
    .replace(SENSITIVE_TEXT_PATTERNS[4], '$1[REDACTED]')
    .replace(SENSITIVE_TEXT_PATTERNS[5], '$1[REDACTED]');
}

function secureTokenMatches(actual, expected) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function sendJson(response, statusCode, body, headers = {}) {
  const data = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(data);
}

async function readTextLimited(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SUPERVISOR_BYTES) {
    throw new Error('Supervisor response exceeded the size limit');
  }
  if (!response.body) throw new Error('Supervisor returned an empty response');

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SUPERVISOR_BYTES) {
      await reader.cancel();
      throw new Error('Supervisor response exceeded the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function parseRelevantLogBlocks(rawText) {
  const lines = rawText.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const blocks = [];
  let currentBlock;
  for (const line of lines) {
    const record = line.match(LOG_RECORD_PATTERN);
    if (record) {
      currentBlock = ERROR_LEVELS.has(record[1].toLowerCase()) ? [line] : undefined;
      if (currentBlock) blocks.push(currentBlock);
    } else if (currentBlock) {
      currentBlock.push(line);
    }
  }
  return { blocks, sourceLineCount: lines.length };
}

function limitBlocksByLines(blocks, lineLimit) {
  const selected = [];
  let remaining = lineLimit;
  let truncated = false;

  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = blocks[index];
    if (block.length <= remaining) {
      selected.unshift(block);
      remaining -= block.length;
      continue;
    }

    const partial = remaining === 1 ? [block[0]] : [block[0], ...block.slice(-(remaining - 1))];
    selected.unshift(partial);
    remaining = 0;
    truncated = true;
  }
  if (blocks.length > selected.length) truncated = true;
  return { blocks: selected, truncated };
}

function buildBoundedResult({ blocks, lines, sourceLineCount, initiallyTruncated }) {
  const safeBlocks = blocks.map((block) =>
    block.map((line) => redactSensitiveText(line).slice(0, MAX_LINE_CHARS)),
  );
  let truncated = initiallyTruncated;

  const makeResult = () => {
    const entries = safeBlocks.flat();
    return {
      source: 'home_assistant_core',
      requested_lines: lines,
      returned_lines: entries.length,
      truncated,
      entries,
    };
  };

  let result = makeResult();
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
    truncated = true;
    if (safeBlocks.length > 1) safeBlocks.shift();
    else if (safeBlocks[0]?.length > 1) safeBlocks[0].splice(1, 1);
    else break;
    result = makeResult();
  }

  result.truncated = truncated || sourceLineCount >= lines;
  return result;
}

export async function fetchCoreErrorLogs({ lines, supervisorToken, fetchImpl = fetch }) {
  const url = new URL('http://supervisor/core/logs');
  url.searchParams.set('lines', String(lines));
  url.searchParams.set('no_colors', '');

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'text/plain',
      authorization: `Bearer ${supervisorToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Supervisor log source request failed');

  const { blocks, sourceLineCount } = parseRelevantLogBlocks(await readTextLimited(response));
  const limited = limitBlocksByLines(blocks, lines);
  return buildBoundedResult({
    blocks: limited.blocks,
    lines,
    sourceLineCount,
    initiallyTruncated: limited.truncated,
  });
}

export function createDiagnosticsServer({
  diagnosticsToken,
  supervisorToken,
  fetchImpl = fetch,
  logger = logEvent,
}) {
  if (!/^[a-f0-9]{64}$/i.test(diagnosticsToken)) {
    throw new Error('A 64-character hexadecimal diagnostics token is required');
  }
  if (!supervisorToken) throw new Error('Supervisor API access is unavailable');

  const rateLimits = new Map();
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method !== 'GET' || url.pathname !== '/api/v1/logs/errors') {
      return sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    }

    const now = Date.now();
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    const existing = rateLimits.get(remoteAddress);
    const rate =
      !existing || existing.resetAt <= now ? { count: 0, resetAt: now + RATE_WINDOW_MS } : existing;
    rate.count += 1;
    rateLimits.set(remoteAddress, rate);
    if (rateLimits.size > 1024) rateLimits.delete(rateLimits.keys().next().value);

    const rateHeaders = {
      'ratelimit-limit': String(MAX_REQUESTS),
      'ratelimit-remaining': String(Math.max(0, MAX_REQUESTS - rate.count)),
      'ratelimit-reset': String(Math.ceil(rate.resetAt / 1000)),
    };
    if (rate.count > MAX_REQUESTS) {
      logger('warning', 'request_rate_limited');
      return sendJson(
        response,
        429,
        { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
        { ...rateHeaders, 'retry-after': String(Math.ceil((rate.resetAt - now) / 1000)) },
      );
    }

    const authorization = request.headers.authorization ?? '';
    const prefix = 'Bearer ';
    const suppliedToken = authorization.startsWith(prefix)
      ? authorization.slice(prefix.length)
      : '';
    if (!secureTokenMatches(suppliedToken, diagnosticsToken)) {
      logger('warning', 'authentication_failed');
      return sendJson(
        response,
        401,
        { error: 'unauthorized', message: 'Missing or invalid bearer token.' },
        rateHeaders,
      );
    }

    if ([...url.searchParams.keys()].some((key) => key !== 'lines')) {
      return sendJson(
        response,
        400,
        { error: 'invalid_request', message: 'Only the lines query parameter is supported.' },
        rateHeaders,
      );
    }
    const lineValues = url.searchParams.getAll('lines');
    const rawLines = lineValues[0] ?? String(DEFAULT_LINES);
    if (lineValues.length > 1 || !/^[1-9]\d{0,2}$/.test(rawLines)) {
      return sendJson(
        response,
        400,
        { error: 'invalid_request', message: 'lines must be an integer from 1 to 500.' },
        rateHeaders,
      );
    }
    const lines = Number(rawLines);
    if (lines > MAX_LINES) {
      return sendJson(
        response,
        400,
        { error: 'invalid_request', message: 'lines must be an integer from 1 to 500.' },
        rateHeaders,
      );
    }

    try {
      const result = await fetchCoreErrorLogs({ lines, supervisorToken, fetchImpl });
      logger('info', 'core_logs_returned', {
        requested_lines: lines,
        returned_lines: result.returned_lines,
      });
      return sendJson(response, 200, result, rateHeaders);
    } catch {
      logger('error', 'supervisor_request_failed');
      return sendJson(
        response,
        503,
        {
          error: 'log_source_unavailable',
          message: 'The Home Assistant log source is unavailable.',
        },
        rateHeaders,
      );
    }
  });
}

async function main() {
  logEvent('info', 'startup_begin', { version: APP_VERSION });
  const options = JSON.parse(await readFile('/data/options.json', 'utf8'));
  logEvent('info', 'configuration_loaded');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.setgid('node');
    process.setuid('node');
    logEvent('info', 'privileges_dropped', {
      uid: process.getuid(),
      gid: process.getgid(),
    });
  }
  const server = createDiagnosticsServer({
    diagnosticsToken: options.diagnostics_token,
    supervisorToken: process.env.SUPERVISOR_TOKEN,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8099, '0.0.0.0', resolve);
  });
  logEvent('info', 'listening', { host: '0.0.0.0', port: 8099 });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      logEvent('info', 'shutdown_requested', { signal });
      server.close((error) => {
        if (error) {
          logEvent('error', 'shutdown_failed');
          process.exit(1);
        }
        logEvent('info', 'shutdown_complete');
        process.exit(0);
      });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    let category = 'startup_failed';
    if (error?.code === 'EACCES') category = 'configuration_unreadable';
    else if (error instanceof SyntaxError) category = 'configuration_invalid_json';
    else if (error?.message === 'A 64-character hexadecimal diagnostics token is required') {
      category = 'configuration_invalid_token';
    } else if (error?.message === 'Supervisor API access is unavailable') {
      category = 'supervisor_token_unavailable';
    }
    logEvent('error', 'startup_failed', { category });
    process.exit(1);
  });
}
