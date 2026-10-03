// Run on the deployment host with private environment values, never in CI.
// Does not print credentials and refuses to overwrite an existing realm.
import { randomBytes } from 'node:crypto';
import { buildKeycloakRealm, OWNER_ROLES } from './keycloak-realm.mjs';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';

const { fetch, URLSearchParams, AbortSignal } = globalThis;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const base = required('KEYCLOAK_INTERNAL_URL').replace(/\/$/, '');
const resource = required('MCP_PUBLIC_URL');
const secret = required('OAUTH_ADMIN_PASSWORD');
const admin = required('OAUTH_ADMIN_USER');
const callback = required('CHATGPT_REDIRECT_URI');
const clientSecret = randomBytes(32).toString('hex');
const realm = 'home-assistant';
const grant = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: admin,
    password: secret,
  }),
  signal: AbortSignal.timeout(10000),
});
if (!grant.ok) throw new Error(`Bootstrap authentication failed (${grant.status})`);
const { access_token: bearer } = await grant.json();
const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Keycloak configuration failed (${response.status}) at ${path}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
};
const existing = await fetch(`${base}/admin/realms/${realm}`, {
  headers: { authorization: `Bearer ${bearer}` },
});
if (existing.status !== 404)
  throw new Error('Realm already exists or cannot be inspected; refusing to overwrite it.');
await api('realms', 'POST', buildKeycloakRealm(resource, callback, clientSecret));
const password = randomBytes(32).toString('base64url');
await api(`realms/${realm}/users`, 'POST', {
  username: 'home-owner',
  enabled: true,
  emailVerified: false,
  credentials: [{ type: 'password', value: password, temporary: true }],
});
const users = await api(`realms/${realm}/users?username=home-owner&exact=true`);
if (users.length !== 1) throw new Error('Unable to identify the dedicated owner user.');
const roles = await Promise.all(OWNER_ROLES.map((role) => api(`realms/${realm}/roles/${role}`)));
await api(`realms/${realm}/users/${users[0].id}/role-mappings/realm`, 'POST', roles);
await writeFile(
  required('KEYCLOAK_ACCESS_FILE'),
  `Username: home-owner\nTemporary password: ${password}\nClient ID: ha-chatgpt\nClient Secret: ${clientSecret}\nAuthentication: confidential client; PKCE S256 required.\nEnter the client secret only in the OAuth connection settings.\nChange the temporary password during your first login.\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Realm, scoped owner, resource and PKCE client configured. Credentials saved to the private access file.',
);
