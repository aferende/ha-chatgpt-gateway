# Home Assistant ChatGPT Gateway Plugin — v0.7.0

Version 0.7.0 introduces a breaking integration change from GPT Actions to MCP/Keycloak. This guide documents the tested migration; legacy REST is retained as an optional compatibility interface.

## Why migrate

OpenAI schedules custom GPT retirement for **December 11, 2026**. **February 11, 2027** applies only to eligible Enterprise workspaces with an approved deferral. Follow account-specific notices. See the [official retirement FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq).

Custom GPT instructions and reference files can migrate, but Actions do not transfer automatically. This project adds an MCP interface while retaining REST and OpenAPI for existing users.

New deployments use `ENABLE_LEGACY_REST_API=false`: `/api/v1/*` and `/openapi.json` are absent and unused `GATEWAY_*_API_KEY` settings can be removed. Internal actions remain available through MCP. Keep the flag true and valid scoped keys for REST consumers that have not yet migrated. With REST disabled, MCP must be enabled; configurations without an interface fail startup.

The public name from v0.7.0 is **Home Assistant ChatGPT Gateway Plugin**. The repository, npm package and GHCR identifiers remain `ha-chatgpt-gateway`.

## Architecture and privacy

```text
ChatGPT / Codex plugin -- HTTPS + OAuth access token --> self-hosted gateway
                                                        |
                                                   entity policy
                                                        |
                                           Home Assistant in the LAN
```

The Home Assistant token stays on the gateway host. It is never a plugin credential, tool parameter or manifest field. OAuth credentials are scoped to the gateway. No OpenAI inference API or OpenAI API key is needed.

Self-hosting does not make inference local: selected tool results are sent to ChatGPT. Review exposed entities and their attributes, particularly cameras, location, history and logs. Begin with a deliberately small safe allowlist and read-only operation.

## Features and compatibility

MCP mirrors the existing REST operations: health, safe configuration, diagnostics, entity/area/device discovery, entity state/history, automation configuration, live service contracts, generic single and multi-entity calls, ordered batches, asynchronous dispatch status and opt-in administration. Logbook and diagnostic logs are advertised only when their existing feature flags are enabled.

Both interfaces invoke the same action handlers and preserve service target policies, recursive group resolution, batch prevalidation, template/prototype-pollution blocking, read/write scopes and timeouts. Dispatch results belong to the credential/identity that created them.

MCP is stateless Streamable HTTP with JSON responses and no unsolicited event stream. Existing asynchronous dispatch remains in process memory, as before. Transport requests and tool executions are rate-limited; service operations also use the existing stricter write limiter. Use only explicitly trusted proxy peers.

## Keycloak is the standard OAuth provider

All supported deployments use the included Keycloak/PostgreSQL stack. Synology OAuth Service is not used: its observed native resource/token interfaces did not establish a secure external resource-server integration.

Copy `.env.example` to `.env` for gateway settings and `.env.keycloak.example` to `.env.keycloak` for provider settings. Restrict both files to their owner. Generate administrator/database passwords independently with `openssl rand -hex 32` (or Node's `crypto.randomBytes(32).toString('hex')`). The Keycloak file contains no Home Assistant token and must not be added to the gateway's `env_file` list.

## Installation checklist and startup scripts

1. Clone the release repository and prepare the two private files.
2. Set the actual LAN Home Assistant URL/token in the gateway file, HTTPS MCP/issuer/JWKS URLs, read-only mode and a small domain policy.
3. Set provider HTTPS URL, administrator/database passwords, exact callback and the private output path in the provider file.
4. Start the stack with `sh scripts/install-compose.sh` or PowerShell `./scripts/install-compose.ps1`. For source builds use `--build` or `-Build`.
5. Wait for Keycloak to start; configure the public TLS proxy and keep administration/database endpoints private.
6. Run the bootstrap helper below. It creates the resource/client/user and saves credentials locally.
7. Enter Client ID/Secret in the manual OAuth settings of the personal ChatGPT MCP plugin; sign in and change the temporary password.
8. Verify tools and install the skill. Enable writes only after an explicit safe allowlist and a successful read-only test.

The startup scripts create missing example files without overwriting existing settings, validate required fields, protect file permissions and use quiet Compose validation. No secret belongs in a public command example or Git commit.

Start the stack with private environment values:

```sh
docker compose --env-file .env.keycloak -f docker-compose.oauth.yml --profile oauth up -d
```

Keycloak and PostgreSQL images are pinned to verified digests. Keycloak binds only to loopback port 8790; the database has no published port. Configure a trusted HTTPS proxy for the application realm and login assets. Do not expose the Keycloak admin API, master realm, database, or management ports. Disable automatic image replacement; upgrade deliberately with configuration/database backups.

For Nginx, use [the bounded Keycloak proxy configuration](../deploy/nginx-keycloak.conf). OAuth reconnection with `id_token_hint` can cause large response cookies/headers. The default upstream-header buffer may produce `502` and `upstream sent too big header`, which Synology can disguise as its own not-found page. The sample sets a 32 KiB header buffer and compatible response buffers on the OAuth realm only, with proxy error interception disabled. Verify `nginx -t` before reloading. Do not record OAuth query strings or paste reauthorization URLs into public reports: they can contain ID tokens.

The OAuth realm location disables raw Nginx access/error logging because upstream error messages include the full request URL. Keycloak events and gateway audit events remain available for authentication diagnostics; other proxy locations keep their existing logging. Preserve historical logs for incident analysis, but redact query strings before exporting them.

Use `scripts/keycloak-bootstrap.mjs` once to create the `home-assistant` realm, resource, confidential PKCE client and owner account. The script refuses to overwrite an existing realm and saves the temporary owner password/client secret to a private file. Required inputs:

- `KEYCLOAK_INTERNAL_URL`: loopback administration URL ending in `/oauth`.
- `OAUTH_ADMIN_USER` and `OAUTH_ADMIN_PASSWORD`: provider bootstrap administrator credentials.
- `MCP_PUBLIC_URL`: exact HTTPS MCP resource URL.
- `CHATGPT_REDIRECT_URI`: exact callback from the ChatGPT connection settings.
- `KEYCLOAK_ACCESS_FILE`: new private file for the owner's initial login.

These values are host secrets/configuration, never CI inputs or plugin manifest content. The gateway itself receives no Keycloak administrator password.

After Keycloak starts, configure HTTPS and the exact callback in `.env.keycloak`. With Node.js 22.12+ installed locally:

```sh
mkdir -p private
chmod 700 private
node --env-file=.env.keycloak scripts/keycloak-bootstrap.mjs
```

On Linux/NAS hosts without local Node, run the helper in a temporary container. Mount only scripts and the private output directory:

```sh
mkdir -p private
chmod 700 private
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --env-file .env.keycloak -w /work \
  -v "$PWD/scripts:/work/scripts:ro" -v "$PWD/private:/work/private" \
  node:22-alpine node scripts/keycloak-bootstrap.mjs
```

Docker Desktop users can use local Node rather than assuming Linux host networking. On Windows create the private folder with PowerShell and restrict NTFS permissions. Enter generated credentials directly in connection/login settings, never in a conversation.

Start/manage the complete stack together:

```sh
docker compose --env-file .env --env-file .env.keycloak \
  -f docker-compose.ghcr.yml -f docker-compose.oauth.yml --profile oauth up -d
```

`OAUTH_PUBLIC_URL` is the provider's HTTPS base ending in `/oauth`; the supplied stack uses `KC_HTTP_RELATIVE_PATH=/oauth`. A shared gateway/provider hostname works with the included proxy path rules. Administrator/master endpoints remain local.

Keycloak resource indicators are experimental in the pinned version. Enable only that feature, test resource binding, and retain the previous image/database backup before upgrading. Do not enable CIMD: Keycloak currently documents incompatibility with ChatGPT's CIMD metadata. Use the preregistered `ha-chatgpt` client, Authorization Code and PKCE S256. It is a confidential client with a generated secret, using an advertised `client_secret_post` or `client_secret_basic` method, plus mandatory PKCE S256. Copy the exact redirect from ChatGPT; do not guess a callback or add wildcard redirects.

The `gateway-access` mapper emits a resource-bound audience and `gateway_roles`. Realm roles are `gateway-read` and `gateway-write`; requested OAuth scopes alone never confer write permission. Grant roles only to intended users. New user self-registration is disabled. The owner gets a temporary password and must replace it at first login.

The client must also have the standard `basic` default scope, including Keycloak's `oidc-sub-mapper`. Realm imports with explicit scope definitions may not create this scope automatically, so bootstrap defines it explicitly. Human access tokens must include `sub`; successful service-account tests alone cannot verify this. If login succeeds but MCP discovery returns unauthorized because the identity claim is missing, run `scripts/keycloak-enable-identity.mjs` on the host with its private administration environment, then reconnect to obtain a newly issued token. Never remove the gateway's required-subject check to bypass the problem.

ChatGPT may request `openid offline_access read write`. `openid` is an OIDC protocol meta-scope. Assign Keycloak's built-in `offline_access` scope as an **optional client scope** and grant the `offline_access` realm role to the authorized owner. This permits refresh/offline sessions; it does not grant Home Assistant write access. The bootstrap does this automatically. For an earlier candidate installation, run `scripts/keycloak-enable-offline.mjs` on the host using the private provider administration environment. An `invalid_scope` error containing `offline_access` indicates that this assignment is missing; do not remove the scope from ChatGPT or weaken role checks.

A private ZIP exported immediately after registering an MCP connection may contain only `.app.json` and the plugin manifest. It does not automatically include the gateway's reusable instructions. Connect OAuth and verify tools first, then package the supplied skill with that registered app ID and test the complete installed plugin.

Example gateway configuration:

```dotenv
ENABLE_MCP=true
MCP_PUBLIC_URL=https://gateway.example.com/mcp
MCP_OAUTH_ISSUER=https://gateway.example.com/oauth/realms/home-assistant
MCP_OAUTH_JWKS_URL=https://gateway.example.com/oauth/realms/home-assistant/protocol/openid-connect/certs
MCP_OAUTH_REQUIRE_ROLES=true
MCP_SETUP_ONLY=false
```

The gateway verifies signature, issuer, exact resource audience, expiry, scopes and roles. Provider failure does not enable REST keys as an MCP fallback. Read roles cannot execute writes even when the requested scope includes `write`. Existing READ_ONLY, domain/entity and administration policies still apply.

Setup-only mode can publish resource metadata before OAuth is configured; all MCP access remains blocked until setup is completed. The retained generic introspection verifier is not the supported deployment path for v0.7.0.

Sources: [Keycloak MCP integration](https://www.keycloak.org/securing-apps/mcp-authz-server), [Keycloak reverse proxy](https://www.keycloak.org/server/reverseproxy), [OpenAI authentication](https://developers.openai.com/plugins/build/auth).

## Install and connect the plugin

1. Deploy the candidate behind a trusted HTTPS proxy; never publish Home Assistant or its token.
2. Verify `/.well-known/oauth-protected-resource` and the resource-specific metadata path.
3. Configure a private MCP connection in ChatGPT developer mode using the actual MCP URL.
4. For manual OAuth registration, copy the exact redirect URI from the connection management page. Never substitute `/mcp`, `/openapi.json`, a NAS sign-in URL or a guessed callback. See [OpenAI authentication requirements](https://developers.openai.com/plugins/build/auth#redirect-url).
5. Register that callback in Keycloak. Enter Client ID `ha-chatgpt` and the generated Client Secret directly in ChatGPT's OAuth settings. Keep PKCE S256 enabled. Never send the client secret in conversation text.
6. Configure a private copy of `plugin/mcp.json` for the deployment. Keep the public sample hostname unchanged.
7. Install the plugin package and select it explicitly in a new conversation. If a surface requires mapping a registered MCP app ID, use the technical ID displayed by that account; do not reuse someone else's ID.
8. Complete read-only tests before a single safe write and state restoration.

Authentication and account permissions can require user interaction. A public plugin catalog submission is separate from private installation and GitHub release. Never provide a domestic deployment to reviewers; use isolated virtual devices and separate OAuth identities.

## Release and rollback

Build the candidate privately and record source revision, image ID, configuration backup and results. Test NAS, OAuth, REST and ChatGPT before pushing a release. After CI passes and official multiarch images exist, deploy a pinned v0.7.0 tag. Keep the previous digest and .env/compose backup for rollback. Callback and audience changes require reconnecting OAuth and updating the exact callback if it changes.
