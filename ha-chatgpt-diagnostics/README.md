![HA ChatGPT Diagnostics](https://raw.githubusercontent.com/aferende/ha-chatgpt-gateway/refs/heads/main/ha-chatgpt-diagnostics/banner.png)

# HA ChatGPT Diagnostics

Safely expose a small, bounded view of recent Home Assistant Core warnings and
errors to HA ChatGPT Gateway—without giving the Internet-facing gateway direct
Supervisor access.

## What it does

```text
ChatGPT → HTTPS → HA ChatGPT Gateway
                    ↓ trusted LAN + dedicated bearer token
              Diagnostics companion
                    ↓ fixed Supervisor request
              Home Assistant Core logs
```

- Reads only the fixed Supervisor source `GET /core/logs`.
- Keeps warning, error, critical, and fatal records together with their
  directly following traceback or continuation lines.
- Accepts between 1 and 500 recent source lines per request.
- Applies strict response-size limits, timeouts, rate limits, and redaction.
- Returns data only through one authenticated, read-only diagnostics endpoint.
- Produces compact English lifecycle logs with ISO-8601 UTC timestamps.

## Designed for least exposure

The companion is deliberately separate from the public gateway. The gateway
never receives a Supervisor token, and the companion provides no shell,
generic proxy, Docker socket, host networking, ingress, or filesystem mounts.
Its host port is disabled by default and must be mapped deliberately on a
trusted network.

> **Important permission note:** Home Assistant currently requires
> `hassio_role: homeassistant` to read Core logs. This role is broader than the
> single operation used by this app. The app never calls or exposes lifecycle
> operations, but the residual permission risk is documented and should be
> considered before installation.

## Available endpoints

| Endpoint                            | Authentication         | Purpose                                                     |
| ----------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `GET /health`                       | None                   | Minimal liveness result only                                |
| `GET /api/v1/logs/errors?lines=100` | Dedicated bearer token | Bounded Core warning/error records and continuation context |

## Safe defaults

- The network port is not published automatically.
- Unknown parameters and arbitrary source selection are rejected.
- Responses use `Cache-Control: no-store`.
- Tokens, authorization headers, and returned Home Assistant log text are
  never written to the app's own log.
- Traceback context is subject to the same line, byte, per-line, and redaction
  bounds as record headers.
- Regex redaction is defense in depth; fixed scope, authentication, bounds,
  and network isolation remain the primary controls.

For installation, configuration, testing, and the full threat model, open the
**Documentation** tab or read [DOCS.md](DOCS.md).
