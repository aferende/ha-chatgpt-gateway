import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config/env.js';
import { recordRateLimit, type RateLimitAuditMetadata } from './audit.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  decision: 'allowed' | 'blocked';
  count: number;
  remaining: number;
  resetAt: number;
}

export const MAX_RATE_LIMIT_BUCKETS = 4096;

export class InMemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxBuckets = MAX_RATE_LIMIT_BUCKETS,
  ) {}

  consume(key: string, now = Date.now()): RateLimitResult {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.entries.size >= this.maxBuckets) this.cleanup(now);
      if (!entry && this.entries.size >= this.maxBuckets) {
        this.entries.delete(this.entries.keys().next().value as string);
      }
      entry = { count: 0, resetAt: now + this.windowMs };
    } else {
      this.entries.delete(key);
    }
    entry.count += 1;
    this.entries.set(key, entry);
    return {
      decision: entry.count > this.limit ? 'blocked' : 'allowed',
      count: entry.count,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  cleanup(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function applyRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: RateLimitAuditMetadata['scope'],
  limit: number,
  limiter: InMemoryRateLimiter,
  key: string,
  headerPrefix = 'RateLimit',
): RateLimitResult {
  const result = limiter.consume(key);
  reply.header(`${headerPrefix}-Limit`, limit);
  reply.header(`${headerPrefix}-Remaining`, result.remaining);
  reply.header(`${headerPrefix}-Reset`, Math.ceil(result.resetAt / 1000));
  recordRateLimit(request, {
    scope,
    decision: result.decision,
    limit,
    count: result.count,
    remaining: result.remaining,
    reset_at: new Date(result.resetAt).toISOString(),
  });
  return result;
}

function recordDisabled(request: FastifyRequest, scope: RateLimitAuditMetadata['scope']): void {
  recordRateLimit(request, { scope, decision: 'disabled', limit: 0, count: 0, remaining: 0 });
}

/** Limits only failed authentication attempts, before any protected route handler runs. */
export function createPreAuthRateLimitHook(config: GatewayConfig) {
  const limiter = new InMemoryRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  return async function guardAuthentication(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    if (request.gatewayAuth) return;
    if (config.rateLimitMax === 0) {
      recordDisabled(request, 'gateway_pre_auth');
    } else {
      const result = applyRateLimit(
        request,
        reply,
        'gateway_pre_auth',
        config.rateLimitMax,
        limiter,
        request.ip,
      );
      if (result.decision === 'blocked') {
        reply.header('Retry-After', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
        return reply.code(429).send({
          error: 'rate_limited',
          message: 'Too many failed authentication attempts. Try again shortly.',
        });
      }
    }
    return reply.code(401).send({
      error: 'unauthorized',
      message: 'A valid Bearer API key is required.',
    });
  };
}

/** Limits authenticated work independently by credential ID and resolved client IP. */
export function createAuthenticatedRateLimitHook(config: GatewayConfig) {
  const limiter = new InMemoryRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  return async function rateLimitAuthenticated(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    if (!request.gatewayAuth) return;
    if (config.rateLimitMax === 0) {
      recordDisabled(request, 'gateway_authenticated');
      return;
    }
    const credentialId = request.gatewayAuth.credentialIds.join(',') || 'unknown';
    const result = applyRateLimit(
      request,
      reply,
      'gateway_authenticated',
      config.rateLimitMax,
      limiter,
      `${credentialId}:${request.ip}`,
    );
    if (result.decision === 'blocked') {
      reply.header('Retry-After', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many requests. Try again shortly.',
      });
    }
  };
}

/** A stricter write-only limiter keyed by authenticated credential ID and client IP. */
export function createServiceRateLimitHook(config: GatewayConfig) {
  const limiter = new InMemoryRateLimiter(
    config.serviceRateLimitMax,
    config.serviceRateLimitWindowMs,
  );
  return async function rateLimitServiceCall(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    if (config.serviceRateLimitMax === 0) {
      recordDisabled(request, 'gateway_service');
      return;
    }
    const credentialId = request.gatewayAuth?.credentialIds.join(',') || 'unknown';
    const result = applyRateLimit(
      request,
      reply,
      'gateway_service',
      config.serviceRateLimitMax,
      limiter,
      `${credentialId}:${request.ip}`,
      'ServiceRateLimit',
    );
    if (result.decision === 'blocked') {
      reply.header('Retry-After', Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)));
      return reply.code(429).send({
        error: 'rate_limited',
        message: 'Too many service calls. Try again shortly.',
      });
    }
  };
}
