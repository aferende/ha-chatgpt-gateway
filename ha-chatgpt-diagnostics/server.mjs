/* global AbortSignal, fetch */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
const MAX_RATE_LIMIT_BUCKETS = 1024;
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

function logMessage(event, fields) {
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
  return messages[event] ?? event;
}

export function formatLogEvent(level, event, fields = {}, timestamp = new Date()) {
  return JSON.stringify({
    timestamp: timestamp.toISOString(),
    level,
    event,
    message: logMessage(event, fields),
    ...fields,
  });
}

export function formatLifecycleEvent(level, event, fields = {}, timestamp = new Date()) {
  return `${timestamp.toISOString()} ${level.toUpperCase()} ${logMessage(event, fields)}`;
}

function writeLogLine(level, line) {
  if (level === 'error') console.error(line);
  else if (level === 'warning') console.warn(line);
  else console.log(line);
}

function logAuditEvent(level, event, fields = {}) {
  writeLogLine(level, formatLogEvent(level, event, fields));
}

function logLifecycleEvent(level, event, fields = {}) {
  writeLogLine(level, formatLifecycleEvent(level, event, fields));
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

export class BoundedRateLimiter {
  #entries = new Map();

  constructor(
    limit = MAX_REQUESTS,
    windowMs = RATE_WINDOW_MS,
    maxBuckets = MAX_RATE_LIMIT_BUCKETS,
  ) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
  }

  consume(key, now = Date.now()) {
    let entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.#entries.size >= this.maxBuckets) this.cleanup(now);
      if (!entry && this.#entries.size >= this.maxBuckets) {
        this.#entries.delete(this.#entries.keys().next().value);
      }
      entry = { count: 0, resetAt: now + this.windowMs };
    } else {
      this.#entries.delete(key);
    }
    entry.count += 1;
    this.#entries.set(key, entry);
    return {
      decision: entry.count > this.limit ? 'blocked' : 'allowed',
      count: entry.count,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
  }

  get size() {
    return this.#entries.size;
  }
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
  logger = logAuditEvent,
  auditHmacKey,
  auditLogRawIps = false,
}) {
  if (!/^[a-f0-9]{64}$/i.test(diagnosticsToken)) {
    throw new Error('A 64-character hexadecimal diagnostics token is required');
  }
  if (!supervisorToken) throw new Error('Supervisor API access is unavailable');

  if (auditHmacKey !== undefined && !/^[a-f0-9]{64}$/i.test(auditHmacKey)) {
    throw new Error('A 64-character hexadecimal audit HMAC key is required when configured');
  }
  const hmacKey = auditHmacKey ? Buffer.from(auditHmacKey, 'hex') : randomBytes(32);
  const fingerprint = (address) =>
    createHmac('sha256', hmacKey).update(address).digest('hex').slice(0, 24);
  const preAuthRateLimits = new BoundedRateLimiter();
  const authenticatedRateLimits = new BoundedRateLimiter();

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method !== 'GET' || url.pathname !== '/api/v1/logs/errors') {
      return sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    }

    const startedAt = process.hrtime.bigint();
    const now = Date.now();
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    const suppliedRequestId = request.headers['x-request-id'];
    const requestId =
      typeof suppliedRequestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        suppliedRequestId,
      )
        ? suppliedRequestId
        : randomUUID();
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
    let authOutcome = authorization === undefined ? 'missing' : match ? 'invalid' : 'malformed';
    if (match && secureTokenMatches(match[1], diagnosticsToken)) authOutcome = 'authenticated';

    const limiter = authOutcome === 'authenticated' ? authenticatedRateLimits : preAuthRateLimits;
    const rateScope =
      authOutcome === 'authenticated' ? 'diagnostics_authenticated' : 'diagnostics_pre_auth';
    const rate = limiter.consume(remoteAddress, now);
    const rateHeaders = {
      'ratelimit-limit': String(MAX_REQUESTS),
      'ratelimit-remaining': String(rate.remaining),
      'ratelimit-reset': String(Math.ceil(rate.resetAt / 1000)),
    };
    const finish = (status, body, headers = {}, requestedLines) => {
      const fields = {
        request_id: requestId,
        method: request.method,
        route: '/api/v1/logs/errors',
        status,
        status_code: status,
        duration_ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 100_000) / 10,
        source_fingerprint: fingerprint(remoteAddress),
        auth_outcome: authOutcome,
        rate_limit_scope: rateScope,
        rate_limit_decision: rate.decision,
        rate_limit_limit: MAX_REQUESTS,
        rate_limit_count: rate.count,
        rate_limit_remaining: rate.remaining,
        rate_limit_reset_at: new Date(rate.resetAt).toISOString(),
        ...(requestedLines === undefined ? {} : { requested_lines: requestedLines }),
        ...(auditLogRawIps ? { source_ip: remoteAddress } : {}),
      };
      logger(
        status === 401 || status === 429 || status >= 500 ? 'warning' : 'info',
        'diagnostics_request_completed',
        fields,
      );
      return sendJson(response, status, body, { ...rateHeaders, ...headers });
    };

    if (rate.decision === 'blocked') {
      return finish(
        429,
        { error: 'rate_limited', message: 'Too many requests. Try again shortly.' },
        { 'retry-after': String(Math.max(1, Math.ceil((rate.resetAt - now) / 1000))) },
      );
    }
    if (authOutcome !== 'authenticated') {
      return finish(401, {
        error: 'unauthorized',
        message: 'Missing or invalid bearer token.',
      });
    }

    if ([...url.searchParams.keys()].some((key) => key !== 'lines')) {
      return finish(400, {
        error: 'invalid_request',
        message: 'Only the lines query parameter is supported.',
      });
    }
    const lineValues = url.searchParams.getAll('lines');
    const rawLines = lineValues[0] ?? String(DEFAULT_LINES);
    if (lineValues.length > 1 || !/^[1-9]\d{0,2}$/.test(rawLines)) {
      return finish(400, {
        error: 'invalid_request',
        message: 'lines must be an integer from 1 to 500.',
      });
    }
    const lines = Number(rawLines);
    if (lines > MAX_LINES) {
      return finish(400, {
        error: 'invalid_request',
        message: 'lines must be an integer from 1 to 500.',
      });
    }

    try {
      const result = await fetchCoreErrorLogs({ lines, supervisorToken, fetchImpl });
      return finish(200, result, {}, lines);
    } catch {
      return finish(
        503,
        {
          error: 'log_source_unavailable',
          message: 'The Home Assistant log source is unavailable.',
        },
        {},
        lines,
      );
    }
  });
}

async function main() {
  logLifecycleEvent('info', 'startup_begin', { version: APP_VERSION });
  const options = JSON.parse(await readFile('/data/options.json', 'utf8'));
  logLifecycleEvent('info', 'configuration_loaded');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.setgid('node');
    process.setuid('node');
    logLifecycleEvent('info', 'privileges_dropped', {
      uid: process.getuid(),
      gid: process.getgid(),
    });
  }
  const server = createDiagnosticsServer({
    diagnosticsToken: options.diagnostics_token,
    supervisorToken: process.env.SUPERVISOR_TOKEN,
    auditHmacKey: options.audit_hmac_key || undefined,
    auditLogRawIps: options.audit_log_raw_ips === true,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(8099, '0.0.0.0', resolve);
  });
  logLifecycleEvent('info', 'listening', { host: '0.0.0.0', port: 8099 });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      logLifecycleEvent('info', 'shutdown_requested', { signal });
      server.close((error) => {
        if (error) {
          logLifecycleEvent('error', 'shutdown_failed');
          process.exit(1);
        }
        logLifecycleEvent('info', 'shutdown_complete');
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
    logLifecycleEvent('error', 'startup_failed', { category });
    process.exit(1);
  });
}
