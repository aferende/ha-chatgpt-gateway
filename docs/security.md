# Security

## Trust boundaries

- ChatGPT knows only one gateway credential: preferably `GATEWAY_WRITE_API_KEY`, or the backward-compatible `GATEWAY_API_KEY`.
- HA ChatGPT Gateway knows gateway credentials and `HOME_ASSISTANT_TOKEN`.
- The optional diagnostics companion knows its internal bearer token and receives a Supervisor token with the `homeassistant` role. The Internet-facing gateway never receives the Supervisor token.
- Home Assistant never needs OpenAI credentials.
- `HOME_ASSISTANT_TOKEN` must never be copied into a GPT Action.

## Recommended baseline

- use HTTPS for every public request;
- for a new deployment, run `openssl rand -hex 32` separately for `GATEWAY_READ_API_KEY` and `GATEWAY_WRITE_API_KEY`; each key must be a distinct 64-character hexadecimal value representing 32 random bytes (256-bit nominal entropy). Give the GPT only the write key;
- start with `READ_ONLY=true`, `ALLOWED_DOMAINS=light,switch`, and an empty allow-list only long enough to discover devices;
- then use `ALLOWED_ENTITIES` for a strict, short entity allow-list before enabling writes. The gateway refuses to start with `READ_ONLY=false` when this list is empty;
- avoid exposing sensitive domains such as `lock` and `alarm_control_panel` by default;
- keep `.env` out of version control;
- run the container as an unprivileged user;
- do not expose Home Assistant itself merely to make this gateway work.
- leave `TRUSTED_PROXIES` empty unless an HTTPS reverse proxy is in front of the gateway, then trust only the exact peer IP or the narrowest verified CIDR.

## Safe rollout sequence

1. Keep `READ_ONLY=true` and expose only `light,switch` for discovery.
2. List entities and select one to three harmless, reversible devices. A lamp or an isolated test plug is a good first choice.
3. Set `ALLOWED_ENTITIES` to those exact entity IDs and restart the container.
4. Test state reads, then one on/off cycle while physically observing the device.
5. Set `READ_ONLY=false` only after those tests pass.
6. Add devices one at a time. Keep an allow-list permanently rather than relying on a broad domain policy.

Avoid initially authorizing the following, even if their entity IDs are in an otherwise common domain:

- door, gate, garage, shutter, or blind controls;
- alarm, lock, camera, presence, and security-related entities;
- climate/heating controls and appliances;
- scripts and scenes, because their internal effects can be broader than their names suggest;
- plugs powering a NAS, router, Home Assistant host, medical device, or other critical equipment.

## Policy details

`ALLOWED_DOMAINS` is required. `ALLOWED_ENTITIES` may be empty only in `READ_ONLY=true` discovery mode. Write-enabled deployments require a non-empty exact entity-ID allow-list. Every entity in a multi-entity service call is checked.

Service calls require an explicit `entity_id` or legacy `target.entity_id`. Before forwarding a write, the gateway resolves group-like entity targets recursively into concrete entity IDs. Every concrete result must stay in the requested domain and pass the entity allow-list; one blocked member, target cycle, malformed group, or excessive expansion rejects the entire call before any service call is sent. The gateway deliberately rejects global calls and `device_id`, `area_id`, and `label_id` targets.

Long-running automations and scripts are a special availability case: Home Assistant's service API returns only after the service has executed. `ENABLE_ASYNC_SERVICE_DISPATCH` is therefore opt-in and limited to exact allowed domains in `ASYNC_SERVICE_DOMAINS`. A queued call returns `202` and a random dispatch ID; the gateway keeps a bounded in-memory status record and limits concurrent background calls. `202` means only that the gateway started the upstream request, not that Home Assistant completed it. Do not enable it for broad or unreviewed domains.

Target-less maintenance calls remain blocked unless `ENABLE_ADMIN_ACTIONS=true` and the exact action is in `ADMIN_ALLOWED_ACTIONS`. The supported set is deliberately small: configuration checks, selected reloads, Home Assistant restart, and automation/scene/script reload. This endpoint still requires a write key, `READ_ONLY=false`, and the service rate limiter. It never permits arbitrary global calls, `homeassistant.stop`, or global turn-on/off actions.

For GPT Actions, parameterized service data is sent as a structured `data` JSON object. The legacy `data_json` string form is also parsed locally for compatibility. Both forms reject target fields hidden in the payload, Home Assistant template expressions, and prototype-pollution keys before the normal domain/entity policy is applied. When a Home Assistant service contract advertises an entity-valued data field, every submitted entity is resolved and policy-checked just like a root target. A service with no explicit entity target is blocked rather than treated as a global call. For response-only Home Assistant services, the gateway adds the API's required `return_response` flag based on the live service contract; this does not affect authorization or target validation. `POST /api/v1/services/batch` resolves and validates every call in a batch before performing its first write, executes them in order, and stops on an upstream error. It cannot roll back a service that Home Assistant has already completed.

`GATEWAY_READ_API_KEY` has only `read` scope. `GATEWAY_WRITE_API_KEY` has `read` and `write` scopes because the GPT must discover entities and services before acting. `GATEWAY_API_KEY` remains a backward-compatible read/write key; migrate to separate scoped keys to reduce the effect of a leaked read-only credential. Every configured key must use the strict 64-hex-character format and must differ from every other configured key. Service endpoints have a separate in-memory limit controlled by `SERVICE_RATE_LIMIT_MAX` and `SERVICE_RATE_LIMIT_WINDOW_MS`, in addition to the general endpoint rate limit.

An allowed script, scene, or automation can itself produce indirect effects outside the entity targeted by its own service call. The gateway cannot safely infer all of those internal effects at runtime. Treat permission to run one of these entities as permission for its complete Home Assistant behavior, and do not grant them to a write-capable key unless that behavior has been reviewed.

An in-memory per-client rate limiter runs before authentication on every protected API request, including missing, malformed, and invalid Bearer credentials. Configure it with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`, or set `RATE_LIMIT_MAX=0` only when another trusted limiter protects the endpoint. The separate service-call limiter protects writes with `SERVICE_RATE_LIMIT_MAX` and `SERVICE_RATE_LIMIT_WINDOW_MS`. Home Assistant requests have a bounded timeout controlled by `HOME_ASSISTANT_TIMEOUT_MS`.

`TRUSTED_PROXIES` controls Fastify's native `trustProxy` setting. It is empty by default, so forwarded headers from a direct client are ignored and the socket peer remains the rate-limit identity. When an exact proxy peer IP or verified CIDR is configured, Fastify walks only that trusted forwarding chain and uses the first untrusted address as `request.ip`; both the general limiter and the credential-plus-client service limiter then use the real client address. A trusted proxy must set or preserve `X-Forwarded-For` correctly. Never configure universal trust, and do not trust a forwarded header merely because it arrived from the Internet.

Fastify request logs contain request IDs, method, route, status, and duration. The application never logs the Home Assistant token, gateway key, or Authorization header; error responses are deliberately generic and do not include upstream response bodies.

## Optional diagnostics companion

Core error logs require the documented Supervisor `/core/logs` endpoint, which is unavailable to the normal Home Assistant REST API. Keeping that access in a separately installed app prevents the Internet-facing gateway from receiving Supervisor credentials and preserves normal gateway operation when diagnostics are absent.

The companion requests `hassio_api: true` with `hassio_role: homeassistant`, the smallest documented role that authorizes `/core/logs`. Supervisor roles are coarse: this role also authorizes state-changing `/core/*` endpoints. The implementation reduces exposure by hard-coding one GET endpoint and never exposing a proxy, but a compromised companion process could misuse its Supervisor token. Keep protection mode enabled and install only reviewed images.

The externally reachable companion surface is one token-protected, rate-limited route with a fixed source and bounded `lines` parameter. It keeps warning/error/critical/fatal records and their directly following continuation or traceback lines until a new record begins. Every retained line is redacted and remains subject to line, per-line, upstream-byte, and downstream-byte caps; an oversized traceback cannot bypass those limits. Tracebacks can disclose more context than one-line messages, so regex redaction remains incomplete defense in depth rather than the security boundary. Network isolation, authentication, fixed routing, bounds, and minimization are primary.

The host port mapping is disabled by default. A Raspberry Pi gateway on another host requires an explicit LAN mapping; restrict it to that source with network firewalling where available. Never publish the companion through Home Assistant ingress, router forwarding, or Tailscale Funnel. Plain LAN HTTP does not protect the token from a network observer, so use an isolated trusted network or private encrypted overlay when needed.

Companion lifecycle and request-result logs use English messages with ISO-8601 UTC timestamps. They contain metadata only: never bearer tokens, Authorization headers, Supervisor response bodies, or returned Core-log content.
