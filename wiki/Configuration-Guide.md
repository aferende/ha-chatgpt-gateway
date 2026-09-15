# Configuration Guide

All runtime configuration is supplied through environment variables, normally in a local `.env` file beside the Compose file.

Never commit `.env`. It contains Home Assistant and gateway credentials.

## Minimal first-run configuration

A safe initial configuration looks like this:

```env
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=replace_with_your_token

GATEWAY_READ_API_KEY=replace_with_a_unique_64_hex_key
GATEWAY_WRITE_API_KEY=replace_with_a_different_64_hex_key

ALLOWED_DOMAINS=light,switch
ALLOWED_ENTITIES=
READ_ONLY=true

PUBLIC_BASE_URL=https://ha-gateway.example.com
```

Generate each gateway key independently with:

```bash
openssl rand -hex 32
```

## Connection settings

| Variable                            | Required | Default | Purpose                                                                   |
| ----------------------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `PORT`                              | No       | `8787`  | HTTP port used by the gateway container.                                  |
| `HOME_ASSISTANT_URL`                | Yes      | —       | Home Assistant base URL reachable from the gateway host/container.        |
| `HOME_ASSISTANT_TOKEN`              | Yes      | —       | Home Assistant Long-Lived Access Token. Keep it only on the gateway host. |
| `HOME_ASSISTANT_TIMEOUT_MS`         | No       | `10000` | Timeout for reads, discovery, and internal registry requests.             |
| `HOME_ASSISTANT_SERVICE_TIMEOUT_MS` | No       | `30000` | Timeout for normal synchronous Home Assistant service calls.              |

## Gateway credentials

| Variable                | Recommended | Scope        | Notes                                                                               |
| ----------------------- | ----------- | ------------ | ----------------------------------------------------------------------------------- |
| `GATEWAY_READ_API_KEY`  | Yes         | Read         | Useful for monitoring or discovery clients. Cannot call services.                   |
| `GATEWAY_WRITE_API_KEY` | Yes         | Read + write | Preferred credential for the GPT Action.                                            |
| `GATEWAY_API_KEY`       | Legacy only | Read + write | Backward-compatible full-access credential. Prefer scoped keys for new deployments. |

Every configured gateway key must:

- contain exactly 64 hexadecimal characters;
- be generated independently;
- differ from every other configured gateway key.

Give the GPT only the write-capable gateway key. Never give it `HOME_ASSISTANT_TOKEN`.

## Policy settings

| Variable           | Required            | Recommended first value | Purpose                                                       |
| ------------------ | ------------------- | ----------------------- | ------------------------------------------------------------- |
| `ALLOWED_DOMAINS`  | Yes                 | `light,switch`          | Home Assistant domains visible through the gateway.           |
| `ALLOWED_ENTITIES` | Required for writes | empty during discovery  | Exact entity IDs allowed by the gateway policy.               |
| `READ_ONLY`        | No                  | `true`                  | Blocks service calls while keeping read operations available. |

### Recommended rollout

Start with:

```env
ALLOWED_DOMAINS=light,switch
ALLOWED_ENTITIES=
READ_ONLY=true
```

Discover one to three harmless entities, then set an exact list:

```env
ALLOWED_ENTITIES=light.desk_lamp,switch.test_plug
```

Only then change:

```env
READ_ONLY=false
```

The gateway refuses to start in write mode if `ALLOWED_ENTITIES` is empty.

## Public HTTPS

| Variable          | Required                             | Purpose                                                                                       |
| ----------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL` | For GPT Action deployment            | Public HTTPS origin advertised in `/openapi.json`. Example: `https://ha-gateway.example.com`. |
| `TRUSTED_PROXIES` | Only behind a verified reverse proxy | Exact proxy peer IPs or narrow CIDRs allowed to supply forwarding headers.                    |

`PUBLIC_BASE_URL` should normally use HTTPS on standard port `443`, with no path suffix.

Leave `TRUSTED_PROXIES` empty until you have verified the actual peer address seen by the container. Do not configure universal trust or broad networks merely for convenience.

## Rate limiting

| Variable                       | Default | Purpose                                                                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_MAX`               | `120`   | Separate maximum for failed auth per client IP and authenticated work per credential + IP. `0` disables both. |
| `RATE_LIMIT_WINDOW_MS`         | `60000` | General limiter window in milliseconds.                                                                       |
| `SERVICE_RATE_LIMIT_MAX`       | `20`    | Stricter limit for service calls per authenticated credential and source IP.                                  |
| `SERVICE_RATE_LIMIT_WINDOW_MS` | `60000` | Service-call limiter window.                                                                                  |

Do not disable these limits unless another trusted limiter protects the endpoint.

## Long-running automations and scripts

Asynchronous dispatch is optional and disabled by default.

| Variable                                  | Default   | Purpose                                                              |
| ----------------------------------------- | --------- | -------------------------------------------------------------------- |
| `ENABLE_ASYNC_SERVICE_DISPATCH`           | `false`   | Enables prompt `202` responses for selected entity-targeted domains. |
| `ASYNC_SERVICE_DOMAINS`                   | empty     | Exact subset of allowed domains eligible for asynchronous dispatch.  |
| `HOME_ASSISTANT_ASYNC_SERVICE_TIMEOUT_MS` | `1800000` | Background request timeout.                                          |
| `ASYNC_SERVICE_MAX_CONCURRENT`            | `2`       | Maximum concurrent background service requests.                      |

Typical reviewed configuration:

```env
ENABLE_ASYNC_SERVICE_DISPATCH=true
ASYNC_SERVICE_DOMAINS=automation,script
```

Only enable this for domains you understand and explicitly allow. A `202` response means the gateway started the upstream request; it does not prove that the Home Assistant action has completed.

## Home Assistant maintenance actions

Target-less administration calls are disabled by default.

| Variable                | Default | Purpose                                        |
| ----------------------- | ------- | ---------------------------------------------- |
| `ENABLE_ADMIN_ACTIONS`  | `false` | Enables the separate administration endpoint.  |
| `ADMIN_ALLOWED_ACTIONS` | empty   | Exact maintenance actions permitted by policy. |

Supported reviewed actions include configuration checks, selected reloads, Home Assistant restart, and automation/scene/script reload.

Example:

```env
ENABLE_ADMIN_ACTIONS=true
ADMIN_ALLOWED_ACTIONS=homeassistant.check_config,automation.reload,script.reload
```

Do not enable actions you do not intend the GPT to use.

## Logging

| Variable    | Default | Purpose                 |
| ----------- | ------- | ----------------------- |
| `LOG_LEVEL` | `info`  | Fastify/Pino log level. |

The application is designed not to log the Home Assistant token, gateway API keys, or Authorization header.

## Basic versus advanced configuration

For most users, the only settings needed initially are:

```text
HOME_ASSISTANT_URL
HOME_ASSISTANT_TOKEN
GATEWAY_READ_API_KEY
GATEWAY_WRITE_API_KEY
ALLOWED_DOMAINS
ALLOWED_ENTITIES
READ_ONLY
PUBLIC_BASE_URL
```

Treat asynchronous dispatch, administration actions, custom timeouts, and proxy trust as advanced settings. Add them only when a real deployment requirement exists.

For the canonical template and exact current defaults, always check the repository's [.env.example](https://github.com/aferende/ha-chatgpt-gateway/blob/main/.env.example).
