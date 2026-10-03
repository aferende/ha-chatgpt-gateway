# Troubleshooting

## Invalid scope

Assign the client's optional `offline_access` scope and the authorized user's offline role. Do not remove gateway role enforcement.

## Authentication succeeded, action discovery failed

Confirm the standard `basic` scope/subject mapper and reconnect for a new token. Check issuer, audience, expiry, roles and public JWKS reachability. HTTP 200 alone does not prove a tool succeeded.

## Synology not-found page during reconnect

Nginx can intercept an upstream error caused by large OAuth response headers. Use the bounded OAuth header buffers and error-interception settings in the [proxy example](https://github.com/aferende/ha-chatgpt-gateway/blob/main/deploy/nginx-keycloak.conf).

## Tools unavailable after export

A connection-only ZIP lacks the reusable skill. Complete OAuth discovery, package the skill with the registered app and test a new chat.

## Forbidden or read-only

Review Keycloak roles, `READ_ONLY`, entity/domain allowlists and admin action policy. Consent does not bypass server authorization.

## History or long automation

Inspect bounds/sampling. Use asynchronous domains for long scripts/automations. A queued response does not prove completion.

## Secrets in diagnostics

Never share complete OAuth URLs, tokens, Authorization headers or private environment files. OAuth proxy raw-query logging is disabled; use provider/gateway events.

[Full guide](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/plugin-migration.md) · [Security](https://github.com/aferende/ha-chatgpt-gateway/blob/main/docs/security.md)
