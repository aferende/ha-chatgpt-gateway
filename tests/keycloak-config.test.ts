import { describe, expect, it } from 'vitest';
import { buildKeycloakRealm, OWNER_ROLES } from '../scripts/keycloak-realm.mjs';

describe('ChatGPT Keycloak bootstrap configuration', () => {
  it('supports the exact OpenID/offline/read/write request sent by ChatGPT', () => {
    const realm = buildKeycloakRealm(
      'https://gateway.example.com/mcp',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'test-only-client-secret',
    );
    const client = realm.clients.find(
      (entry: { clientId: string }) => entry.clientId === 'ha-chatgpt',
    );
    expect(client.defaultClientScopes).toEqual(['basic', 'read', 'write', 'gateway-access']);
    expect(client.optionalClientScopes).toContain('offline_access');
    // openid is an OIDC protocol meta-scope, not a custom Keycloak scope.
    expect(realm.clientScopes.some((scope: { name: string }) => scope.name === 'openid')).toBe(
      false,
    );
    expect(OWNER_ROLES).toContain('offline_access');
    expect(client.attributes['pkce.code.challenge.method']).toBe('S256');
    expect(client.directAccessGrantsEnabled).toBe(false);
  });
  it('keeps resource binding and gateway roles independent from session persistence', () => {
    const resource = 'https://gateway.example.com/mcp';
    const realm = buildKeycloakRealm(
      resource,
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'test-only-client-secret',
    );
    const resourceClient = realm.clients.find(
      (entry: { clientId: string }) => entry.clientId === 'ha-gateway-resource',
    );
    expect(resourceClient.attributes.resource_url).toBe(resource);
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.roles.realm.map((role: { name: string }) => role.name)).toEqual([
      'gateway-read',
      'gateway-write',
    ]);
  });
  it('imports the standard subject mapper, rather than relying on service-account token behavior', () => {
    const realm = buildKeycloakRealm(
      'https://gateway.example.com/mcp',
      'https://chatgpt.com/connector_platform_oauth_redirect',
      'test-only-client-secret',
    );
    const basic = realm.clientScopes.find((scope: { name: string }) => scope.name === 'basic');
    expect(basic.protocolMappers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocolMapper: 'oidc-sub-mapper',
          config: expect.objectContaining({ 'access.token.claim': 'true' }),
        }),
      ]),
    );
    expect(basic.attributes['include.in.token.scope']).toBe('false');
  });
});
