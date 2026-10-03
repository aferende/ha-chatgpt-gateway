// Controlled backend smoke test. Temporary service-account clients are removed.
// This is not a substitute for the user's real ChatGPT Authorization Code test.
import process from 'node:process';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const { fetch, URLSearchParams, AbortSignal } = globalThis;
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const base = env('KEYCLOAK_INTERNAL_URL').replace(/\/$/, '');
const resource = env('MCP_PUBLIC_URL');
const realm = 'home-assistant';
const adminGrant = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: env('OAUTH_ADMIN_USER'),
    password: env('OAUTH_ADMIN_PASSWORD'),
  }),
  signal: AbortSignal.timeout(10000),
});
if (!adminGrant.ok) throw new Error('Smoke-test administration authentication failed.');
const { access_token: adminToken } = await adminGrant.json();
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}/admin/realms/${realm}/${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Smoke-test configuration failed (${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const clients = [];
async function access(role) {
  const id = `gateway-smoke-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  await api('clients', 'POST', {
    clientId: id,
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    secret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    fullScopeAllowed: true,
    defaultClientScopes: ['read', 'write', 'gateway-access'],
  });
  const [client] = await api(`clients?clientId=${id}`);
  clients.push(client.id);
  const user = await api(`clients/${client.id}/service-account-user`);
  await api(`users/${user.id}/role-mappings/realm`, 'POST', [await api(`roles/${role}`)]);
  const response = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
      scope: 'read write',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Smoke-test token grant failed (${response.status}).`);
  return (await response.json()).access_token;
}
const request = async (token, method, params = {}) => {
  const response = await fetch(resource, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`MCP transport failed (${response.status}).`);
  const result = await response.json();
  if (result.error) throw new Error('MCP protocol failed.');
  return result.result;
};
const tool = async (token, name, args = {}) => {
  const result = await request(token, 'tools/call', { name, arguments: args });
  const parsed = JSON.parse(result.content[0].text);
  return { ...parsed, isError: result.isError };
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
try {
  const reader = await access('gateway-read');
  const writer = await access('gateway-write');
  const initialized = await request(reader, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'controlled-keycloak-smoke', version: '1' },
  });
  assert(initialized.serverInfo.name === 'ha-chatgpt-gateway', 'Unexpected server.');
  const tools = await request(reader, 'tools/list');
  assert(tools.tools.length >= 16, 'Missing tools.');
  const diagnostics = await tool(reader, 'getGatewayDiagnostics');
  assert(diagnostics.data.home_assistant.reachable, 'Home Assistant unavailable.');
  const blocked = await tool(reader, 'callHomeAssistantService', {
    domain: 'switch',
    service: 'turn_on',
    entity_id: ['switch.gateway_smoke'],
  });
  assert(blocked.status === 403, 'Read identity unexpectedly gained write access.');
  const writerHealth = await tool(writer, 'getGatewayHealth');
  assert(writerHealth.status === 200, 'Writer cannot read.');
  const denied = await tool(writer, 'getHomeAssistantEntity', {
    entityId: 'lock.gateway_smoke_forbidden',
  });
  assert(denied.status === 403, 'Forbidden domain/entity was accepted.');
  if (process.env.SMOKE_ALLOW_WRITE === 'true') {
    const entity = env('SMOKE_ENTITY_ID');
    assert(
      /^(light|switch)\.[a-z0-9_]+$/.test(entity),
      'The operator must choose an explicit reviewed harmless light or switch.',
    );
    const domain = entity.split('.')[0];
    const before = await tool(writer, 'getHomeAssistantEntityState', { entityId: entity });
    assert(
      before.data.state === 'on' || before.data.state === 'off',
      'Test entity is not controllable.',
    );
    const original = before.data.state;
    const changed = original === 'on' ? 'off' : 'on';
    try {
      const change = await tool(writer, 'callHomeAssistantService', {
        domain,
        service: `turn_${changed}`,
        entity_id: [entity],
      });
      assert(change.status === 200, 'Test write was not confirmed.');
      let observed;
      for (let i = 0; i < 8; i++) {
        observed = await tool(writer, 'getHomeAssistantEntityState', { entityId: entity });
        if (observed.data.state === changed) break;
        await delay(500);
      }
      assert(observed.data.state === changed, 'State change was not observed.');
    } finally {
      const restore = await tool(writer, 'callHomeAssistantService', {
        domain,
        service: `turn_${original}`,
        entity_id: [entity],
      });
      assert(restore.status === 200, 'Restoration was not confirmed.');
    }
    let restored;
    for (let i = 0; i < 12; i++) {
      restored = await tool(writer, 'getHomeAssistantEntityState', { entityId: entity });
      if (restored.data.state === original) break;
      await delay(500);
    }
    assert(restored.data.state === original, 'Original state was not restored.');
    console.log('Controlled state change and restoration: PASS');
  }
  console.log(
    'Real Keycloak JWT, MCP initialize/list, HA read, read/write scope isolation and forbidden entity: PASS',
  );
} finally {
  for (const id of clients) await api(`clients/${id}`, 'DELETE');
}
