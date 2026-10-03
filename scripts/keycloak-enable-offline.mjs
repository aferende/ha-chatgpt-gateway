// Targeted, idempotent upgrade for realms created before offline_access support.
import process from 'node:process';
import console from 'node:console';
const { fetch, URLSearchParams, AbortSignal } = globalThis;
const base = process.env.KEYCLOAK_INTERNAL_URL?.replace(/\/$/, '');
if (!base || !process.env.OAUTH_ADMIN_USER || !process.env.OAUTH_ADMIN_PASSWORD)
  throw new Error('Missing private provider administration settings.');
const grant = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.OAUTH_ADMIN_USER,
    password: process.env.OAUTH_ADMIN_PASSWORD,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!grant.ok) throw new Error(`Provider authentication failed (${grant.status}).`);
const { access_token: bearer } = await grant.json();
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}/admin/realms/home-assistant/${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Provider configuration failed (${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const [client] = await api('clients?clientId=ha-chatgpt');
if (!client) throw new Error('Dedicated ChatGPT client not found.');
const scope = (await api('client-scopes')).find((entry) => entry.name === 'offline_access');
if (!scope) throw new Error('Built-in offline_access scope not found.');
await api(`clients/${client.id}/optional-client-scopes/${scope.id}`, 'PUT');
const [user] = await api('users?username=home-owner&exact=true');
if (!user) throw new Error('Dedicated owner account not found.');
const role = await api('roles/offline_access');
await api(`users/${user.id}/role-mappings/realm`, 'POST', [role]);
const optional = await api(`clients/${client.id}/optional-client-scopes`);
if (!optional.some((entry) => entry.name === 'offline_access'))
  throw new Error('Offline scope verification failed.');
console.log(
  'ChatGPT offline_access enabled for the dedicated client and owner; gateway read/write roles unchanged.',
);
