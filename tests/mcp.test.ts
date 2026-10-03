import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { buildActionTools } from '../src/mcp/server.js';
import { loadMcpConfig } from '../src/mcp/config.js';
import { makeConfig, sampleStates, TEST_GATEWAY_KEY } from './helpers.js';

const mcp = {
  publicUrl: 'https://gateway.example.com/mcp',
  issuer: 'https://login.example.com',
  jwksUrl: 'https://login.example.com/jwks',
  setupOnly: false,
};
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = await exportJWK(keys.publicKey);
});
const oauthFetch: typeof fetch = async () => Response.json({ keys: [{ ...jwk, kid: 'test' }] });
async function token(scope = 'read', audience = mcp.publicUrl, expires = '5m', roles?: string[]) {
  return new SignJWT({ scope, gateway_roles: roles })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(mcp.issuer)
    .setSubject('test-user')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(keys.privateKey);
}
const headers = (bearer: string) => ({
  authorization: `Bearer ${bearer}`,
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
});
const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('MCP migration', () => {
  it('serves MCP actions while legacy HTTP routes and keys are retired', async () => {
    const app = await buildApp({
      config: makeConfig({
        mcp,
        legacyRestApiEnabled: false,
        gatewayApiKey: '',
        gatewayCredentials: [],
      }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    for (const url of ['/openapi.json', '/api/v1/entities', '/api/v1/config']) {
      const response = await app.inject({ method: 'GET', url, headers: headers(TEST_GATEWAY_KEY) });
      expect(response.statusCode).toBe(404);
    }
    expect((await app.inject('/health')).statusCode).toBe(200);
    const health = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token()),
      payload: call('getGatewayHealth'),
    });
    expect(health.json().result.isError).toBe(false);
    const retired = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(TEST_GATEWAY_KEY),
      payload: call('getGatewayHealth'),
    });
    expect(retired.statusCode).toBe(401);
    await app.close();
  });
  it('rejects signed tokens that omit the subject even when scopes and roles are correct', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp: { ...mcp, requireRoles: true } }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const missingSubject = await new SignJWT({
      scope: 'openid offline_access read write',
      gateway_roles: ['gateway-read', 'gateway-write'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(mcp.issuer)
      .setAudience(mcp.publicUrl)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(missingSubject),
      payload: call('getGatewayHealth'),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
  it('does not turn OpenID/offline access into Home Assistant write permission', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp: { ...mcp, requireRoles: true } }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const auth = headers(
      await token('openid offline_access read write', mcp.publicUrl, '5m', [
        'offline_access',
        'gateway-read',
      ]),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth,
      payload: call('callHomeAssistantService', {
        domain: 'light',
        service: 'turn_on',
        entity_id: ['light.living_room'],
      }),
    });
    expect(JSON.parse(response.json().result.content[0].text).status).toBe(403);
    await app.close();
  });
  it('requires Keycloak roles independently of requested read/write scopes', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp: { ...mcp, requireRoles: true } }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token('read write')),
      payload: call('getGatewayHealth'),
    });
    expect(missing.statusCode).toBe(401);
    const reader = headers(await token('read write', mcp.publicUrl, '5m', ['gateway-read']));
    const health = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: reader,
      payload: call('getGatewayHealth'),
    });
    expect(health.json().result.isError).toBe(false);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: reader,
      payload: call('callHomeAssistantService', {
        domain: 'light',
        service: 'turn_on',
        entity_id: ['light.living_room'],
      }),
    });
    expect(JSON.parse(forbidden.json().result.content[0].text).status).toBe(403);
    await app.close();
  });
  it('accepts only active introspected tokens bound to the expected issuer and resource', async () => {
    let active = true;
    const introspectionFetch: typeof fetch = async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(String(init?.body)).toContain('token=opaque-test-token');
      return Response.json({
        active,
        iss: mcp.issuer,
        sub: 'opaque-user',
        aud: mcp.publicUrl,
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: 'read',
      });
    };
    const app = await buildApp({
      config: makeConfig({
        mcp: {
          ...mcp,
          jwksUrl: undefined,
          introspectionUrl: 'https://login.example.com/introspect',
          clientId: 'resource-server',
          clientSecret: 'test-only-secret',
        },
      }),
      oauthFetchImpl: introspectionFetch,
      logger: false,
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers('opaque-test-token'),
      payload: call('getGatewayHealth'),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().result.isError).toBe(false);
    active = false;
    const revoked = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers('opaque-test-token'),
      payload: call('getGatewayHealth'),
    });
    expect(revoked.statusCode).toBe(401);
    await app.close();
  });

  it('enforces read-only mode even for a valid OAuth write token', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp, readOnly: true }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token('write')),
      payload: call('callHomeAssistantService', {
        domain: 'light',
        service: 'turn_on',
        entity_id: ['light.living_room'],
      }),
    });
    const result = JSON.parse(response.json().result.content[0].text);
    expect(result.status).toBe(403);
    expect(result.data.error).toBe('read_only');
    await app.close();
  });

  it('applies the write-specific service limiter to OAuth calls', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp, readOnly: true, serviceRateLimitMax: 1 }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const auth = headers(await token('write'));
    for (const expectedStatus of [403, 429]) {
      const response = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: auth,
        payload: call('callHomeAssistantService', {
          domain: 'light',
          service: 'turn_on',
          entity_id: ['light.living_room'],
        }),
      });
      expect(JSON.parse(response.json().result.content[0].text).status).toBe(expectedStatus);
    }
    await app.close();
  });
  it('is disabled by default and refuses unvalidated production OAuth configuration', () => {
    expect(loadMcpConfig({})).toBeUndefined();
    expect(() =>
      loadMcpConfig({
        ENABLE_MCP: 'true',
        MCP_PUBLIC_URL: mcp.publicUrl,
        MCP_OAUTH_ISSUER: mcp.issuer,
      }),
    ).toThrow();
    expect(
      loadMcpConfig({
        ENABLE_MCP: 'true',
        MCP_PUBLIC_URL: mcp.publicUrl,
        MCP_OAUTH_ISSUER: mcp.issuer,
        MCP_SETUP_ONLY: 'true',
      })?.setupOnly,
    ).toBe(true);
  });
  it('generates schemas for the existing capabilities without secrets or unresolved refs', () => {
    const tools = buildActionTools(makeConfig());
    expect(tools).toHaveLength(16);
    expect(new Set(tools.map(({ tool }) => tool.name)).size).toBe(16);
    const serialized = JSON.stringify(tools);
    expect(serialized).not.toContain('$ref');
    expect(serialized).not.toContain(TEST_GATEWAY_KEY);
    expect(serialized).not.toContain('ha-test-token');
    expect(
      buildActionTools(makeConfig({ logbookEnabled: true, errorLogsEnabled: true })),
    ).toHaveLength(18);
  });
  it('publishes metadata but setup mode cannot invoke tools with a REST key', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp: { ...mcp, setupOnly: true }, rateLimitMax: 2 }),
      logger: false,
    });
    const metadata = await app.inject('/.well-known/oauth-protected-resource/mcp');
    expect(metadata.json().resource).toBe(mcp.publicUrl);
    for (const status of [401, 401, 429]) {
      const result = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: headers(TEST_GATEWAY_KEY),
        payload: call('getGatewayHealth'),
      });
      expect(result.statusCode).toBe(status);
      expect(result.headers['www-authenticate']).toContain('resource_metadata=');
    }
    await app.close();
  });
  it('initializes using a signed, resource-bound OAuth token', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token()),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.serverInfo.name).toBe('ha-chatgpt-gateway');
    const health = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token()),
      payload: call('getGatewayHealth'),
    });
    expect(health.json().result.isError).toBe(false);
    expect(JSON.parse(health.json().result.content[0].text).data.status).toBe('ok');
    await app.close();
  });
  it('rejects wrong audience, expired token, absent scope, REST key and untrusted Origin', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    for (const bearer of [
      await token('read', 'https://other.example.com/mcp'),
      await token('read', mcp.publicUrl, '-1m'),
      await token(''),
      TEST_GATEWAY_KEY,
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: headers(bearer),
        payload: call('getGatewayHealth'),
      });
      expect(result.statusCode).toBe(401);
    }
    const origin = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers(await token()), origin: 'https://untrusted.example.com' },
      payload: call('getGatewayHealth'),
    });
    expect(origin.statusCode).toBe(403);
    await app.close();
  });
  it('keeps scope and entity enforcement in the shared action, without internal HTTP', async () => {
    const app = await buildApp({
      config: makeConfig({ mcp, allowedEntities: new Set(['light.living_room']) }),
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const write = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token()),
      payload: call('callHomeAssistantService', {
        domain: 'light',
        service: 'turn_on',
        entity_id: ['light.living_room'],
      }),
    });
    expect(write.json().result.isError).toBe(true);
    expect(JSON.parse(write.json().result.content[0].text).status).toBe(403);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: headers(await token('write')),
      payload: call('getHomeAssistantEntity', { entityId: 'lock.front_door' }),
    });
    expect(JSON.parse(forbidden.json().result.content[0].text).status).toBe(403);
    await app.close();
  });
  it('uses real parameterized service data and validates all batch targets before a write', async () => {
    let writes = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (init?.method === 'POST') {
        writes++;
        return Response.json([]);
      }
      if (String(url).endsWith('/api/services'))
        return Response.json([
          {
            domain: 'light',
            services: { turn_on: { fields: {}, target: { entity: [{ domain: ['light'] }] } } },
          },
        ]);
      if (String(url).includes('/api/states/')) return Response.json(sampleStates[0]);
      return Response.json(sampleStates);
    };
    const app = await buildApp({
      config: makeConfig({ mcp, allowedEntities: new Set(['light.living_room']) }),
      fetchImpl,
      oauthFetchImpl: oauthFetch,
      logger: false,
    });
    const auth = headers(await token('read write'));
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth,
      payload: call('callHomeAssistantService', {
        domain: 'light',
        service: 'turn_on',
        entity_id: ['light.living_room'],
        data: { brightness_pct: 50 },
      }),
    });
    expect(response.json().result).toMatchObject({ isError: false });
    expect(writes).toBe(1);
    const batch = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: auth,
      payload: call('callHomeAssistantServiceBatch', {
        calls: [
          { domain: 'light', service: 'turn_on', entity_id: ['light.living_room'] },
          { domain: 'light', service: 'turn_on', entity_id: ['light.blocked'] },
        ],
      }),
    });
    expect(batch.json().result.isError).toBe(true);
    expect(writes).toBe(1);
    await app.close();
  });
});
