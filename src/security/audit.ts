import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config/env.js';

export type AuthenticationOutcome = 'missing' | 'malformed' | 'invalid' | 'authenticated';
export type RateLimitDecision = 'allowed' | 'blocked' | 'disabled';

export interface RateLimitAuditMetadata {
  scope: 'gateway_pre_auth' | 'gateway_authenticated' | 'gateway_service';
  decision: RateLimitDecision;
  limit: number;
  count: number;
  remaining: number;
  reset_at?: string;
}

interface GatewayAuditContext {
  startedAt: bigint;
  authOutcome: AuthenticationOutcome;
  credentialId?: string;
  rateLimits: RateLimitAuditMetadata[];
}

declare module 'fastify' {
  interface FastifyRequest {
    gatewayAudit?: GatewayAuditContext;
  }
}

const sanitizeUserAgent = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
};

export function recordRateLimit(request: FastifyRequest, metadata: RateLimitAuditMetadata): void {
  request.gatewayAudit?.rateLimits.push(metadata);
}

export function createGatewayAuditHooks(config: GatewayConfig) {
  const hmacKey = config.auditHmacKey ? Buffer.from(config.auditHmacKey, 'hex') : randomBytes(32);
  const fingerprint = (address: string): string =>
    createHmac('sha256', hmacKey).update(address).digest('hex').slice(0, 24);

  const onRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    request.gatewayAudit = {
      startedAt: process.hrtime.bigint(),
      authOutcome: 'missing',
      rateLimits: [],
    };
    reply.header('X-Request-ID', request.id);
  };

  const onResponse = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.auditLogEnabled || !request.gatewayAudit) return;

    const peerAddress = request.socket.remoteAddress ?? 'unknown';
    const clientAddress = request.ip;
    const event: Record<string, unknown> = {
      event: 'request_completed',
      timestamp: new Date().toISOString(),
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url,
      status_code: reply.statusCode,
      duration_ms:
        Math.round(Number(process.hrtime.bigint() - request.gatewayAudit.startedAt) / 100_000) / 10,
      auth_outcome: request.gatewayAudit.authOutcome,
      client_fingerprint: fingerprint(clientAddress),
      peer_fingerprint: fingerprint(peerAddress),
      trusted_proxy_used: (request.ips?.length ?? 1) > 1,
      rate_limits: request.gatewayAudit.rateLimits,
    };
    if (request.gatewayAudit.credentialId) event.credential_id = request.gatewayAudit.credentialId;
    const userAgent = sanitizeUserAgent(request.headers['user-agent']);
    if (userAgent) event.user_agent = userAgent;
    if (config.auditLogRawIps) {
      event.client_ip = clientAddress;
      event.peer_ip = peerAddress;
    }

    if (reply.statusCode === 401 || reply.statusCode === 429 || reply.statusCode >= 500) {
      request.log.warn(event);
    } else {
      request.log.info(event);
    }
  };

  return { onRequest, onResponse };
}
