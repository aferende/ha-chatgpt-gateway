# Configuration Guide

Runtime configuration is environment-based. Keep gateway and provider files separate; provider administration passwords must never enter the gateway container.

## Interfaces

- `ENABLE_MCP=true`: enables MCP at `/mcp`.
- `ENABLE_LEGACY_REST_API=false`: removes legacy REST and OpenAPI HTTP endpoints. Health and internal MCP actions remain available.
- Old environment files default to legacy REST enabled; that mode still requires valid distinct 64-hex gateway keys.
- With REST disabled, MCP must be enabled. Invalid/no-interface configurations fail startup.

## Home Assistant policy

`HOME_ASSISTANT_URL` is LAN-reachable; `HOME_ASSISTANT_TOKEN` stays local.
`ALLOWED_DOMAINS` is required. `ALLOWED_ENTITIES` is mandatory in write mode.
Start with `READ_ONLY=true`; avoid security, network, server and broad-script targets.

## OAuth and proxy

Set `MCP_PUBLIC_URL`, `MCP_OAUTH_ISSUER` and `MCP_OAUTH_JWKS_URL` for Keycloak.
Keep `MCP_OAUTH_REQUIRE_ROLES=true`. Scope requests do not independently grant write permission.
`MCP_SETUP_ONLY=true` exposes metadata but blocks tools while setup is incomplete.
`TRUSTED_PROXIES` trusts nobody by default; configure only the actual reverse-proxy peer.

## Operational settings

Timeouts, general/service rate limits, asynchronous domains, exact admin action allowlists, audit logging and optional logbook/diagnostics remain configurable.
[Gateway example](https://github.com/aferende/ha-chatgpt-gateway/blob/main/.env.example) · [Provider example](https://github.com/aferende/ha-chatgpt-gateway/blob/main/.env.keycloak.example)
