// Targeted upgrade: Keycloak 25+ emits human-token sub through the basic scope.
import process from 'node:process';
import console from 'node:console';
import { buildBasicScope } from './keycloak-realm.mjs';
const { fetch, URLSearchParams, AbortSignal } = globalThis;
const base = process.env.KEYCLOAK_INTERNAL_URL?.replace(/\/$/, '');
if (!base || !process.env.OAUTH_ADMIN_USER || !process.env.OAUTH_ADMIN_PASSWORD)
  throw new Error('Missing private provider settings.');
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
  if (!response.ok) throw new Error(`Identity configuration failed (${response.status}).`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const [client] = await api('clients?clientId=ha-chatgpt');
let basic = (await api('client-scopes')).find((scope) => scope.name === 'basic');
if (!basic) {
  await api('client-scopes', 'POST', buildBasicScope());
  basic = (await api('client-scopes')).find((scope) => scope.name === 'basic');
}
if (!client || !basic) throw new Error('Dedicated client or built-in basic scope not found.');
await api(`clients/${client.id}/default-client-scopes/${basic.id}`, 'PUT');
const [user] = await api('users?username=home-owner&exact=true');
if (!user) throw new Error('Dedicated owner not found.');
const example = await api(
  `clients/${client.id}/evaluate-scopes/generate-example-access-token?userId=${user.id}&scope=openid%20offline_access%20read%20write`,
);
if (typeof example.sub !== 'string' || !example.sub)
  throw new Error('User identity is still missing.');
console.log(
  'Dedicated client now includes the built-in basic scope; human token sub verified without logging identity or tokens.',
);
