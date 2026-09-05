# HA ChatGPT Gateway

Self-hosted Docker gateway that lets a personal ChatGPT GPT Action securely access and control a Home Assistant instance through a small, policy-enforced REST API.

The gateway is designed to run on a NAS, mini PC, Raspberry Pi, VPS, or any Docker host. It does **not** use the OpenAI API and does **not** require an OpenAI API key.

## Architecture

```text
ChatGPT GPT Action
        |
        | HTTPS + Gateway API key
        v
HA ChatGPT Gateway
        |
        | Home Assistant Long-Lived Access Token
        v
Home Assistant REST API
```

## See it in action

These illustrative examples show the progression from one safe device command to coordinated controls and evidence-based analysis. The gateway always applies the configured Home Assistant policy; actual capabilities depend on the entity, the available Home Assistant services, and the allowed domains/entities.

### 1. Simple, confirmed control

[![A GPT Action safely turns on a living-room light through a protected gateway.](assets/example-simple-control.png)](assets/example-simple-control.png)

### 2. Coordinated room comfort

[![A GPT Action coordinates a bedroom thermostat, fan, and dimmed lamp through a protected gateway.](assets/example-room-comfort.png)](assets/example-room-comfort.png)

### 3. Evidence-based energy analysis

[![A GPT Action analyses selected Home Assistant energy history and automation data through a protected gateway.](assets/example-energy-analysis.png)](assets/example-energy-analysis.png)

On mobile, tap an image to open it at full resolution.

## Features

- Node.js 22 + TypeScript + Fastify
- Zod validation
- OpenAPI 3.1 schema suitable for GPT Actions
- Home Assistant state and service discovery
- Live per-service contracts with fields, examples, and selectors from Home Assistant
- Area and device discovery scoped to allowed entities
- Optional bounded Home Assistant logbook access for troubleshooting
- GPT Action-friendly generic service calls and controlled multi-step batches
- Domain and entity allow-lists
- Optional read-only mode
- Separate gateway and Home Assistant credentials
- Docker / Docker Compose deployment
- Multi-stage, non-root container
- GitHub Actions for CI and GHCR publishing
- Vitest, ESLint, and Prettier

## Safe first deployment

Treat the first deployment as a discovery-only session. Do **not** begin by exposing every Home Assistant domain or every entity that happens to be a light or switch. Start in read-only mode with a small domain set, inspect the returned entities, then create an exact allow-list containing only harmless devices that you are comfortable letting ChatGPT control.

Good initial candidates are a test lamp, a desk lamp, or a non-critical smart plug. Do not start with door locks, alarms, garage/gate covers, heating controls, security scripts, appliances, or a plug that powers networking, storage, or medical equipment.

## Quick start

```bash
git clone https://github.com/aferende/ha-chatgpt-gateway.git
cd ha-chatgpt-gateway
cp .env.example .env
```

Edit `.env` and set at least:

```env
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=your_home_assistant_long_lived_token
# Generate each value separately: openssl rand -hex 32
# Preferred: separate credentials. Give the GPT only the write key.
GATEWAY_READ_API_KEY=paste_a_distinct_openssl_rand_hex_32_output_here
GATEWAY_WRITE_API_KEY=paste_a_different_openssl_rand_hex_32_output_here
# Legacy alternative (read/write): GATEWAY_API_KEY=use_a_long_random_secret

# Discovery phase: read only; expose only the two low-risk domains.
ALLOWED_DOMAINS=light,switch
ALLOWED_ENTITIES=
READ_ONLY=true
```

Start with a local build:

```bash
docker compose up -d --build
```

Or, when the GHCR image is available:

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

Check the service:

```bash
curl http://localhost:8787/health
```

While `READ_ONLY=true`, use `GET /api/v1/entities` to identify one to three safe entity IDs. Replace the empty `ALLOWED_ENTITIES` value with those exact IDs, restart the container, and verify reads again. `READ_ONLY=false` refuses to start unless `ALLOWED_ENTITIES` is non-empty.

## Configuration

All runtime configuration is provided through environment variables.

### Connection

- `PORT` — default: `8787`. HTTP port used inside the container.
- `HOME_ASSISTANT_URL` — required. Home Assistant base URL.
- `HOME_ASSISTANT_TOKEN` — required. Home Assistant Long-Lived Access Token.
- `HOME_ASSISTANT_TIMEOUT_MS` — default: `10000`. Timeout in milliseconds for reads, discovery, and internal WebSocket registry requests.
- `HOME_ASSISTANT_SERVICE_TIMEOUT_MS` — default: `30000`. Timeout for a normal synchronous Home Assistant service call.
- `ENABLE_ASYNC_SERVICE_DISPATCH` — default: `false`. Enables prompt `202` responses for long-running, entity-targeted service domains.
- `ASYNC_SERVICE_DOMAINS` — required when asynchronous dispatch is enabled. A subset of `ALLOWED_DOMAINS`, for example `automation,script`.
- `HOME_ASSISTANT_ASYNC_SERVICE_TIMEOUT_MS` — default: `1800000`. Background-request timeout; keep it longer than the longest expected automation.
- `ASYNC_SERVICE_MAX_CONCURRENT` — default: `2`. Maximum concurrently running background service requests.

### Gateway credentials

- Every configured gateway key must be a distinct, exactly 64-character hexadecimal value. Generate each independently with `openssl rand -hex 32`; this supplies 32 random bytes (256-bit nominal entropy).
- `GATEWAY_API_KEY` — backward-compatible read/write key. Configure this key or at least one scoped key.
- `GATEWAY_READ_API_KEY` — optional read-only key for discovery and monitoring clients.
- `GATEWAY_WRITE_API_KEY` — optional read/write key for the GPT Action. Do not reuse the read key or a legacy key.

### Policy

- `ALLOWED_DOMAINS` — required. Comma-separated Home Assistant domains exposed by the gateway.
- `ALLOWED_ENTITIES` — default: empty only while `READ_ONLY=true`. Exact comma-separated entity allow-list. The gateway refuses to start with `READ_ONLY=false` and an empty value.
- `READ_ONLY` — default: `false`. When `true`, blocks service calls while keeping read operations available.
- `ENABLE_LOGBOOK` — default: `false`. Opt-in access to bounded Home Assistant logbook events. Returned entries are filtered by the existing domain/entity policy; state values are omitted by default.
- `ENABLE_ERROR_LOGS` — default: `false`. Registers the bounded error-log route only when the separate diagnostics companion is configured.
- `DIAGNOSTICS_ADDON_URL` — required when error logs are enabled. Fixed base URL of the companion, for example `http://homeassistant.local:8099`.
- `DIAGNOSTICS_ADDON_TOKEN` — required when error logs are enabled. A distinct 64-character hexadecimal bearer token shared only with the companion.
- `ENABLE_ADMIN_ACTIONS` — default: `false`. Enables the separate, exact allow-list of target-less maintenance actions.
- `ADMIN_ALLOWED_ACTIONS` — required when administration actions are enabled. Supported values are `homeassistant.check_config`, `homeassistant.reload_all`, `homeassistant.reload_core_config`, `homeassistant.reload_custom_templates`, `homeassistant.restart`, `automation.reload`, `scene.reload`, and `script.reload`.

### Logging and rate limits

- `LOG_LEVEL` — default: `info`. Fastify/Pino log level.
- `RATE_LIMIT_MAX` — default: `120`. Requests per source IP in the rate-limit window, including missing, malformed, and invalid authentication attempts; `0` disables the in-memory limiter.
- `RATE_LIMIT_WINDOW_MS` — default: `60000`. Rate-limit window in milliseconds.
- `SERVICE_RATE_LIMIT_MAX` — default: `20`. Stricter service-call limit per authenticated key and source IP; `0` disables it.
- `SERVICE_RATE_LIMIT_WINDOW_MS` — default: `60000`. Service-call rate-limit window in milliseconds.
- `TRUSTED_PROXIES` — default: empty (trust nobody). Comma-separated reverse-proxy peer IPs or CIDRs allowed to supply forwarding headers. Configure it only after verifying the peer address seen by the container; this preserves independent client rate-limit buckets behind a proxy without trusting headers sent directly by Internet clients.

See `.env.example` for the complete template. An empty `ALLOWED_ENTITIES` value is appropriate only for a short, read-only discovery phase. A non-empty allow-list also prevents newly added Home Assistant entities from becoming available automatically.

## Public API

The initial API surface is intentionally smaller than Home Assistant's API. The gateway is **not** a transparent reverse proxy.

```text
GET  /health
GET  /openapi.json

GET  /api/v1/config
GET  /api/v1/diagnostics
GET  /api/v1/logbook              # only when ENABLE_LOGBOOK=true
GET  /api/v1/logs/errors           # only when ENABLE_ERROR_LOGS=true
GET  /api/v1/services
GET  /api/v1/services/{domain}/{service}
GET  /api/v1/areas
GET  /api/v1/devices

GET  /api/v1/entities
GET  /api/v1/entities/{entityId}
GET  /api/v1/entities/{entityId}/state
GET  /api/v1/entities/{entityId}/history
GET  /api/v1/automations/{entityId}

POST /api/v1/services/call
POST /api/v1/services/batch
GET  /api/v1/service-dispatches/{dispatchId}
POST /api/v1/admin/actions/call
```

All `/api/v1/*` endpoints require a configured gateway credential:

```http
Authorization: Bearer <GATEWAY_WRITE_API_KEY-or-GATEWAY_API_KEY>
```

`/health` and `/openapi.json` are public so that infrastructure health checks and GPT Action schema import work without exposing Home Assistant credentials.

## Calling Home Assistant services

With `READ_ONLY=false`, the gateway can invoke services belonging to allowed domains.

Example:

```http
POST /api/v1/services/call
Authorization: Bearer <GATEWAY_WRITE_API_KEY-or-GATEWAY_API_KEY>
Content-Type: application/json
```

```json
{
  "domain": "light",
  "service": "turn_on",
  "entity_id": ["light.living_room"],
  "data": {
    "brightness_pct": 50
  }
}
```

For GPT Actions, use `data`: it is a structured JSON object with the dynamic service parameters returned by `GET /api/v1/services/{domain}/{service}`. This lets an Action supply values such as `hvac_mode`, `temperature`, `fan_mode`, brightness, colour, position, or integration-specific fields. `data_json` remains supported as a legacy JSON-object-encoded string for existing clients, but Actions should prefer `data` and must not send both fields.

For a request that requires several Home Assistant services, use one short, ordered batch. For example, an HVAC request can set mode, temperature, and fan mode without inventing a climate-specific gateway endpoint:

```json
{
  "calls": [
    {
      "domain": "climate",
      "service": "set_hvac_mode",
      "entity_id": ["climate.bedroom_air_conditioner"],
      "data": { "hvac_mode": "cool" }
    },
    {
      "domain": "climate",
      "service": "set_temperature",
      "entity_id": ["climate.bedroom_air_conditioner"],
      "data": { "temperature": 27 }
    },
    {
      "domain": "climate",
      "service": "set_fan_mode",
      "entity_id": ["climate.bedroom_air_conditioner"],
      "data": { "fan_mode": "medium" }
    }
  ]
}
```

All calls in a batch are validated before its first write. They then run sequentially and stop on the first Home Assistant error. A batch is not transactional: Home Assistant has no generic rollback facility, so a completed earlier call is not undone.

Every target entity must pass the configured policy. Before a write, group-like entities are resolved recursively into concrete entity IDs; if any resolved member is disallowed, cyclic, malformed, too numerous, or from another domain, the entire call is rejected before Home Assistant receives a service request. Domain-wide service calls, `device_id`, `area_id`, `label_id`, and target-less/global calls remain deliberately refused.

The service name and its parameters are never hard-coded in the gateway. `/api/v1/services` discovers allowed services from Home Assistant, and `/api/v1/services/{domain}/{service}` returns the live contract for one selected service. Use the documented `entity_id` array and structured `data` object for GPT Actions. A single call can target several compatible allowed entities; when a request needs different services, use an ordered batch. Entity-valued fields advertised by a service contract (for example a TTS media-player field or media-player group members) are also checked against the domain/entity policy. For Home Assistant services that require response data, such as forecasts or calendar queries, the gateway automatically requests the required response. Legacy REST clients may continue to use `target.entity_id` or `data_json`.

When `ENABLE_ASYNC_SERVICE_DISPATCH=true`, an individual call in `ASYNC_SERVICE_DOMAINS` returns `202` with a dispatch ID immediately instead of waiting for a long-running action. Query `GET /api/v1/service-dispatches/{dispatchId}` for its eventual gateway-side completion status. `202` means the gateway started the request; it is not a claim that the Home Assistant action has completed. Batches cannot contain asynchronous domains.

Services with no entity target published by Home Assistant remain unavailable, except for the narrow opt-in administration endpoint below. This deliberately excludes broad or global operations even if Home Assistant itself would accept them.

## Home Assistant maintenance actions

Target-less maintenance actions are disabled by default. To enable only reviewed operations, set both variables explicitly:

```env
ENABLE_ADMIN_ACTIONS=true
ADMIN_ALLOWED_ACTIONS=homeassistant.check_config,homeassistant.reload_all,homeassistant.restart,automation.reload,scene.reload,script.reload
```

Then use `POST /api/v1/admin/actions/call` with an exact listed `domain` and `service`, for example `{"domain":"homeassistant","service":"restart"}`. The endpoint still requires a write-capable key, obeys `READ_ONLY`, uses the service rate limit, and rejects every unlisted action. It intentionally does not permit `homeassistant.stop`, target-less turn-on/off operations, or arbitrary global Home Assistant calls.

## History and automation analysis

The gateway exposes bounded, read-only analysis endpoints without becoming a general Home Assistant proxy:

- `GET /api/v1/entities/{entityId}/history` returns minimal state history for one allowed entity. Pass an ISO-8601 `start_time` and optional `end_time`; the interval is limited to 31 days, attributes are omitted, and responses are evenly sampled to 1,000 points by default (up to 5,000).
- `GET /api/v1/automations/{entityId}` returns the configuration of one allowed `automation.*` entity. It redacts values whose keys indicate tokens, passwords, API keys, Authorization data, secrets, or webhooks.

To analyse an appliance's consumption, add its specific energy and power sensor IDs to `ALLOWED_ENTITIES` and permit the `sensor` domain. To inspect its schedule, add only the related `automation.*` IDs and permit `automation`. These endpoints are read-only; enabling a domain does not bypass the entity allow-list for service calls.

## Logbook troubleshooting

Logbook access is intentionally disabled by default. Enable it explicitly:

```env
ENABLE_LOGBOOK=true
```

Then use `GET /api/v1/logbook` with a required ISO-8601 `start_time` and optional `end_time`, `entity_id`, `limit`, and `include_state` parameters.

Security properties:

- requests require a normal gateway credential and use the existing protected-route rate limit;
- unscoped requests without `entity_id` must use a positive interval of no more than 24 hours;
- requests scoped to an allowed `entity_id` may use a positive interval of up to 7 days;
- responses are capped at 500 allowed entries;
- an explicitly requested `entity_id` must pass the existing gateway entity policy;
- unscoped responses keep only entries whose `entity_id` passes the existing domain/entity policy;
- sensitive object fields and common credential patterns are redacted as defense-in-depth only, not as the primary disclosure boundary;
- `include_state=false` is the default so state values such as internal IP addresses or URLs are not disclosed unless explicitly requested.

Example:

```http
GET /api/v1/logbook?start_time=2026-09-02T18:00:00Z&limit=100
Authorization: Bearer <GATEWAY_READ_API_KEY-or-GATEWAY_WRITE_API_KEY>
```

Set `include_state=true` only when state values are required for the specific diagnosis. For normal entity state inspection, prefer the existing entity endpoints.

## Error-log diagnostics companion

Home Assistant Core logs are deliberately not fetched by the normal gateway. The optional companion app runs under Home Assistant Supervisor and exposes one authenticated operation: a bounded excerpt of recent Core warning/error records, including directly following traceback or continuation lines. It has no generic proxy, source selector, shell, Docker socket, or filesystem mount.

The gateway route is absent from both runtime routing and OpenAPI unless all three settings are valid:

```env
ENABLE_ERROR_LOGS=true
DIAGNOSTICS_ADDON_URL=http://homeassistant.local:8099
DIAGNOSTICS_ADDON_TOKEN=<64-hex-token-shared-with-the-companion>
```

`GET /api/v1/logs/errors?lines=100` accepts `1..500`; `100` is the default. It selects warning/error/critical/fatal records and retains their bounded continuation context until a new log record begins. Every retained line is redacted and subject to line, per-line, and response-byte caps. Regex redaction cannot guarantee removal of every secret and remains defense in depth. Keep windows small and never expose the companion through Home Assistant ingress, a router, the Internet, or the gateway's Tailscale Funnel.

Installation, permissions, network guidance, threat model, and a local test procedure are in [the diagnostics companion guide](ha-chatgpt-diagnostics/DOCS.md).

## Read-only mode

For an initial deployment, start with:

```env
READ_ONLY=true
```

Verify authentication, entity visibility, and Home Assistant connectivity. Then enable write operations with:

```env
READ_ONLY=false
```

`READ_ONLY` is an application policy. It is unrelated to Docker Compose's `read_only: true`, which makes the **container filesystem** read-only as a hardening measure.

## Home Assistant token

Create a Home Assistant Long-Lived Access Token for the user the gateway should operate as.

The token is stored only in the gateway's environment and is sent only to Home Assistant. It must never be placed in the GPT Action configuration or committed to Git.

See [docs/home-assistant.md](docs/home-assistant.md).

## GPT Action

After deploying the gateway behind public HTTPS, import:

```text
https://your-gateway.example.com/openapi.json
```

into the GPT Action configuration.

Configure API-key authentication using `GATEWAY_WRITE_API_KEY` (preferred) or the legacy `GATEWAY_API_KEY`, and send it as a Bearer token.

See [docs/chatgpt-action.md](docs/chatgpt-action.md).

## Deployment guides

- [Home Assistant token and connectivity](docs/home-assistant.md)
- [Docker and Docker Compose installation](docs/docker.md)
- [NAS / Synology Docker deployment example](docs/nas-docker.md)
- [Reverse proxy, HTTPS, and router port forwarding](docs/reverse-proxy.md)
- [ChatGPT GPT and Action configuration](docs/chatgpt-action.md)
- [One-prompt Codex deployment assistant](docs/codex-deployment-prompt.md)
- [Security model and safe rollout](docs/security.md)

## HTTPS

Do not expose port `8787` directly to the Internet unless you intentionally terminate TLS elsewhere.

Place the gateway behind an HTTPS reverse proxy such as Caddy, Nginx, Nginx Proxy Manager, Traefik, a NAS reverse proxy, or an equivalent TLS ingress.

When a proxy is used, configure the exact proxy peer in `TRUSTED_PROXIES` so Fastify can safely resolve the real client IP for rate limiting. Leave it empty for direct connections. Never use a universal CIDR or `trustProxy: true`.

See [docs/reverse-proxy.md](docs/reverse-proxy.md).

## Docker images

The repository contains a GitHub Actions workflow intended to publish multi-architecture images to:

```text
ghcr.io/aferende/ha-chatgpt-gateway
```

for:

```text
linux/amd64
linux/arm64
```

This makes deployment possible without installing Node.js or compiling TypeScript on the target NAS.

## Development

Requirements:

- Node.js 22
- npm

Install dependencies:

```bash
npm install
```

Run the checks:

```bash
npm run format:check
npm run lint
npm run test
npm run build
```

Run locally:

```bash
npm run dev
```

## Security model

The gateway deliberately exposes less functionality than Home Assistant itself.

Important properties include:

- Home Assistant token is never exposed to ChatGPT
- separate gateway API key
- timing-safe API-key comparison
- domain allow-list
- optional entity allow-list
- explicit target entity required for state-changing service calls
- read-only mode
- no generic `/api/*` proxy
- non-root container
- read-only container filesystem
- secrets omitted from diagnostics and logs
- optional Core logs isolated in a separately installed, authenticated companion

See [docs/security.md](docs/security.md).

## Project status

`v0.5.0` adds opt-in asynchronous dispatch for long-running automations/scripts and selected Home Assistant maintenance actions. The current main branch also includes opt-in, policy-filtered logbook access. The optional diagnostics companion proposed here adds bounded Home Assistant Core warning/error logs without giving the normal gateway Supervisor access.

## License

MIT. See [LICENSE](LICENSE).
