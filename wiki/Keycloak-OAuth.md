# Keycloak OAuth

Every supported plugin deployment uses the standard self-hosted Keycloak/PostgreSQL stack. Synology OAuth Service is not used.

Bootstrap creates a dedicated realm, MCP resource, confidential client with mandatory PKCE S256 and a scoped owner.
Gateway roles `gateway-read` and `gateway-write` are checked separately from requested scopes.

## Scope requirements learned during integration

- `basic` is a default client scope with the subject mapper: human tokens must contain `sub`.
- `offline_access` is optional on the client and its role is granted to authorized users.
- `openid offline_access read write` must be accepted without turning offline access into write permission.
- Do not use CIMD with the pinned Keycloak version; use the preregistered client.
- Bind the token audience to the exact MCP resource and validate issuer/signature/expiry.

## Maintenance

Access tokens last five minutes. Already issued JWTs may remain valid until expiry after role/session changes.
Back up PostgreSQL, keep administrator access local and handle upgrades deliberately.
OAuth URLs can contain ID-token hints; do not log or publish their query strings.
[Bootstrap and troubleshooting](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/plugin-migration.md)
