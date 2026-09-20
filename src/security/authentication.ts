import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig, GatewayScope } from '../config/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    gatewayAuth?: {
      credentialIds: readonly string[];
      scopes: ReadonlySet<GatewayScope>;
    };
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function createAuthenticationHook(config: GatewayConfig) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization) {
      if (request.gatewayAudit) request.gatewayAudit.authOutcome = 'missing';
      return;
    }

    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) {
      if (request.gatewayAudit) request.gatewayAudit.authOutcome = 'malformed';
      return;
    }
    const token = match[1] as string;

    const scopes = new Set<GatewayScope>();
    const credentialIds: string[] = [];
    // Compare every configured credential before deciding. This avoids turning
    // the configured key set into an early-return timing oracle.
    for (const credential of config.gatewayCredentials) {
      if (safeEqual(token, credential.key)) {
        credentialIds.push(credential.id);
        for (const scope of credential.scopes) scopes.add(scope);
      }
    }

    if (scopes.size === 0) {
      if (request.gatewayAudit) request.gatewayAudit.authOutcome = 'invalid';
      return;
    }

    request.gatewayAuth = { credentialIds, scopes };
    if (request.gatewayAudit) {
      request.gatewayAudit.authOutcome = 'authenticated';
      request.gatewayAudit.credentialId = credentialIds.join(',');
    }
  };
}

export function hasGatewayScope(request: FastifyRequest, scope: GatewayScope): boolean {
  return request.gatewayAuth?.scopes.has(scope) ?? false;
}
