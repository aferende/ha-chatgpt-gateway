import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import type { GatewayConfig } from '../config/env.js';
import { executeGatewayAction } from '../http/actions.js';
import { buildOpenApiSchema } from '../openapi/action-schema.js';
import { createGatewayAuditHooks } from '../security/audit.js';
import {
  createAuthenticatedRateLimitHook,
  createPreAuthRateLimitHook,
} from '../security/rate-limit.js';
import { HomeAssistantError } from '../home-assistant/client.js';
import { DiagnosticsAddonError } from '../diagnostics/client.js';
import { APP_VERSION } from '../version.js';

type Json = Record<string, unknown>;
type ActionTool = {
  tool: Tool;
  method: 'GET' | 'POST';
  path: string;
  parameters: { name: string; in: string; required?: boolean }[];
};

export function buildActionTools(config: GatewayConfig): ActionTool[] {
  const document = buildOpenApiSchema(config.publicBaseUrl, {
    logbookEnabled: config.logbookEnabled,
    errorLogsEnabled: config.errorLogsEnabled,
  }) as unknown as Json;
  const resolve = (value: unknown, depth = 0): unknown => {
    if (depth > 30) throw new Error('Tool schema exceeds maximum depth.');
    if (Array.isArray(value)) return value.map((item) => resolve(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const record = value as Json;
    if (typeof record.$ref === 'string') {
      if (!record.$ref.startsWith('#/'))
        throw new Error('External tool schema references are forbidden.');
      let resolved: unknown = document;
      for (const part of record.$ref.slice(2).split('/')) resolved = (resolved as Json)[part];
      return resolve(resolved, depth + 1);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, resolve(item, depth + 1)]),
    );
  };
  return Object.entries(document.paths as Json).flatMap(([path, item]) =>
    Object.entries(item as Json)
      .filter(([method]) => method === 'get' || method === 'post')
      .map(([method, raw]) => {
        const operation = raw as Json;
        const parameters = (operation.parameters ?? []) as {
          name: string;
          in: string;
          required?: boolean;
          schema?: unknown;
        }[];
        const content = (
          (operation.requestBody as Json | undefined)?.content as Json | undefined
        )?.['application/json'] as Json | undefined;
        const inputSchema: Tool['inputSchema'] =
          method === 'post'
            ? (resolve(content?.schema) as Tool['inputSchema'])
            : {
                type: 'object' as const,
                properties: Object.fromEntries(
                  parameters.map((p) => [p.name, resolve(p.schema) as object]),
                ),
                required: parameters.filter((p) => p.required).map((p) => p.name),
                additionalProperties: false,
              };
        return {
          method: method.toUpperCase() as 'GET' | 'POST',
          path: path.replace(/\{([^}]+)\}/g, ':$1'),
          parameters,
          tool: {
            name: String(operation.operationId),
            description: String(operation.description ?? operation.summary ?? ''),
            inputSchema,
            annotations: {
              readOnlyHint: method === 'get',
              destructiveHint: method === 'post',
              openWorldHint: false,
            },
          },
        };
      }),
  );
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  oauthFetchImpl: typeof fetch = fetch,
): Promise<void> {
  const mcp = config.mcp;
  if (!mcp) return;
  const metadataUrl = new URL('/.well-known/oauth-protected-resource', mcp.publicUrl).toString();
  const metadata = {
    resource: mcp.publicUrl,
    authorization_servers: [mcp.issuer],
    scopes_supported: ['read', 'write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Home Assistant ChatGPT Gateway Plugin',
  };
  app.get('/.well-known/oauth-protected-resource', async () => metadata);
  const resourcePath = new URL(mcp.publicUrl).pathname;
  if (resourcePath !== '/')
    app.get(`/.well-known/oauth-protected-resource${resourcePath}`, async () => metadata);
  const tools = buildActionTools(config);
  const jwks = mcp.jwksUrl
    ? createRemoteJWKSet(new URL(mcp.jwksUrl), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
        [customFetch]: oauthFetchImpl,
      })
    : undefined;

  await app.register(async (scope) => {
    const audit = createGatewayAuditHooks(config);
    const failedLimit = createPreAuthRateLimitHook(config);
    const authenticatedLimit = createAuthenticatedRateLimitHook(config);
    scope.addHook('onRequest', audit.onRequest);
    scope.addHook('onResponse', audit.onResponse);
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      const origin = request.headers.origin;
      if (origin && origin !== new URL(mcp.publicUrl).origin && origin !== 'https://chatgpt.com')
        return reply.code(403).send({ error: 'forbidden', message: 'Origin is not permitted.' });
      const authorization = request.headers.authorization;
      const token =
        typeof authorization === 'string' && authorization.length <= 16384
          ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
          : undefined;
      if (token && !mcp.setupOnly && (jwks || mcp.introspectionUrl)) {
        try {
          let payload: JWTPayload;
          if (jwks) {
            ({ payload } = await jwtVerify(token, jwks, {
              issuer: mcp.issuer,
              audience: mcp.publicUrl,
              algorithms: ['RS256', 'ES256'],
              requiredClaims: ['sub', 'exp', 'iat'],
            }));
          } else {
            const verification = await oauthFetchImpl(mcp.introspectionUrl!, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(5000),
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                authorization: `Basic ${Buffer.from(`${encodeURIComponent(mcp.clientId!)}:${encodeURIComponent(mcp.clientSecret!)}`).toString('base64')}`,
              },
              body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
            });
            if (!verification.ok) throw new Error('OAuth verification failed.');
            const result: unknown = await verification.json();
            if (!result || typeof result !== 'object' || Array.isArray(result))
              throw new Error('Invalid OAuth response.');
            payload = result as JWTPayload;
            const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
            if (
              payload.active !== true ||
              payload.iss !== mcp.issuer ||
              !audience.includes(mcp.publicUrl) ||
              typeof payload.sub !== 'string' ||
              typeof payload.exp !== 'number' ||
              payload.exp <= Date.now() / 1000 ||
              (typeof payload.nbf === 'number' && payload.nbf > Date.now() / 1000)
            )
              throw new Error('OAuth verification failed.');
          }
          const scopes = new Set<'read' | 'write'>();
          const granted = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
          const roles = Array.isArray(payload.gateway_roles) ? payload.gateway_roles : [];
          const canRead =
            !mcp.requireRoles || roles.includes('gateway-read') || roles.includes('gateway-write');
          const canWrite = !mcp.requireRoles || roles.includes('gateway-write');
          if (granted.includes('read') && canRead) scopes.add('read');
          if (granted.includes('write') && canWrite) {
            scopes.add('read');
            scopes.add('write');
          }
          if (scopes.has('read')) {
            const identity = createHash('sha256')
              .update(`${payload.iss}\0${payload.sub}\0${payload.azp ?? ''}`)
              .digest('hex');
            request.gatewayAuth = { credentialIds: [`oauth:${identity}`], scopes };
            if (request.gatewayAudit) {
              request.gatewayAudit.authOutcome = 'authenticated';
              request.gatewayAudit.credentialId = `oauth:${identity}`;
            }
          }
        } catch {
          if (request.gatewayAudit) request.gatewayAudit.authOutcome = 'invalid';
        }
      }
      await failedLimit(request, reply);
      if (reply.sent) return;
      await authenticatedLimit(request, reply);
    });

    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (request, reply) => {
        const server = new Server(
          { name: 'ha-chatgpt-gateway', version: APP_VERSION },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: tools.map(({ tool }) => tool),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (call) => {
          const selected = tools.find(({ tool }) => tool.name === call.params.name);
          if (!selected)
            return {
              isError: true,
              content: [{ type: 'text' as const, text: 'Unknown gateway tool.' }],
            };
          const args = call.params.arguments ?? {};
          const params: Json = {};
          const query: Json = {};
          if (selected.method === 'GET') {
            const allowed = new Set(selected.parameters.map((p) => p.name));
            if (
              Object.keys(args).some((key) => !allowed.has(key)) ||
              selected.parameters.some((p) => p.required && args[p.name] === undefined)
            )
              return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Invalid tool arguments.' }],
              };
            for (const parameter of selected.parameters) {
              if (args[parameter.name] !== undefined)
                (parameter.in === 'path' ? params : query)[parameter.name] = args[parameter.name];
            }
          }
          const action = app.gatewayActions.get(`${selected.method} ${selected.path}`);
          if (!action)
            return {
              isError: true,
              content: [{ type: 'text' as const, text: 'Tool is not available.' }],
            };
          // Count each command independently, including rejected commands. A new
          // reply adapter captures rate-limit failures without writing HTTP twice.
          let limited: unknown;
          const rateReply = {
            sent: false,
            header() {
              return this;
            },
            code() {
              return this;
            },
            send(value: unknown) {
              limited = value;
              this.sent = true;
              return this;
            },
          };
          await authenticatedLimit(
            request,
            rateReply as unknown as Parameters<typeof authenticatedLimit>[1],
          );
          if (limited)
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify(limited) }],
            };
          try {
            const result = await executeGatewayAction(action, request as FastifyRequest, {
              params,
              query,
              body: selected.method === 'POST' ? args : undefined,
            });
            return {
              isError: result.status >= 400,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ status: result.status, data: result.payload }),
                },
              ],
            };
          } catch (error) {
            const code =
              error instanceof HomeAssistantError
                ? error.statusCode === 404
                  ? 'not_found'
                  : 'home_assistant_unavailable'
                : error instanceof DiagnosticsAddonError
                  ? 'diagnostics_addon_unavailable'
                  : 'internal_error';
            app.log.warn({ tool: selected.tool.name, error: code }, 'MCP action failed');
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: code,
                    message: 'The gateway could not complete this action.',
                  }),
                },
              ],
            };
          }
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        try {
          await server.connect(transport);
          const headers = new Headers();
          for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
            const value = request.headers[name];
            if (typeof value === 'string') headers.set(name, value);
          }
          const response = await transport.handleRequest(
            new Request(mcp.publicUrl, { method: request.method, headers }),
            { parsedBody: request.body },
          );
          reply.code(response.status);
          response.headers.forEach((value, name) => reply.header(name, value));
          return reply.send(await response.text());
        } finally {
          await server.close();
        }
      },
    });
  });
}
