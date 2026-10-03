export const OWNER_ROLES = ['gateway-read', 'gateway-write', 'offline_access'];

const scope = (name, mappers = []) => ({
  name,
  protocol: 'openid-connect',
  attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'true' },
  protocolMappers: mappers,
});
const mapper = (name, protocolMapper, config) => ({
  name,
  protocol: 'openid-connect',
  protocolMapper,
  consentRequired: false,
  config,
});

// Realm imports with explicit clientScopes do not necessarily create Keycloak's
// standard basic scope. Match the upstream SubMapper/AuthTime definitions.
export function buildBasicScope() {
  return {
    ...scope('basic', [
      mapper('sub', 'oidc-sub-mapper', {
        'access.token.claim': 'true',
        'introspection.token.claim': 'true',
      }),
      mapper('auth_time', 'oidc-usersessionmodel-note-mapper', {
        'user.session.note': 'AUTH_TIME',
        'claim.name': 'auth_time',
        'jsonType.label': 'long',
        'access.token.claim': 'true',
        'id.token.claim': 'true',
        'introspection.token.claim': 'true',
      }),
    ]),
    attributes: { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' },
  };
}

export function buildKeycloakRealm(resource, callback, clientSecret) {
  return {
    realm: 'home-assistant',
    enabled: true,
    sslRequired: 'external',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    accessTokenLifespan: 300,
    roles: { realm: [{ name: 'gateway-read' }, { name: 'gateway-write' }] },
    clientScopes: [
      buildBasicScope(),
      scope('read'),
      scope('write'),
      scope('gateway-access', [
        mapper('gateway-roles', 'oidc-usermodel-realm-role-mapper', {
          'claim.name': 'gateway_roles',
          multivalued: 'true',
          'jsonType.label': 'String',
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'userinfo.token.claim': 'false',
        }),
        mapper('gateway-audience', 'oidc-audience-mapper', {
          'included.custom.audience': resource,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
        }),
      ]),
    ],
    clients: [
      {
        clientId: 'ha-gateway-resource',
        name: 'Home Assistant Gateway resource',
        enabled: true,
        protocol: 'openid-connect',
        bearerOnly: true,
        attributes: { resource_url: resource },
      },
      {
        clientId: 'ha-chatgpt',
        name: 'Home Assistant ChatGPT Gateway Plugin',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        secret: clientSecret,
        clientAuthenticatorType: 'client-secret',
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [callback],
        webOrigins: ['https://chatgpt.com'],
        fullScopeAllowed: true,
        defaultClientScopes: ['basic', 'read', 'write', 'gateway-access'],
        optionalClientScopes: ['offline_access'],
        attributes: {
          'pkce.code.challenge.method': 'S256',
          'oauth2.device.authorization.grant.enabled': 'false',
        },
      },
    ],
  };
}
