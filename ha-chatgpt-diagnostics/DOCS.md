![HA ChatGPT Diagnostics](https://raw.githubusercontent.com/aferende/ha-chatgpt-gateway/refs/heads/main/ha-chatgpt-diagnostics/banner.png)

# HA ChatGPT Diagnostics

HA ChatGPT Diagnostics gives HA ChatGPT Gateway a deliberately small,
authenticated view of recent **Home Assistant Core warnings and errors**. The
normal gateway continues to work when this optional app is absent.

> **Privacy first:** The app does not provide a shell, arbitrary log access, a
> generic Supervisor proxy, or access to Home Assistant configuration files.

## At a glance

| Property         | Behavior                                                |
| ---------------- | ------------------------------------------------------- |
| Log source       | Home Assistant Core only                                |
| Included records | Warning, error, critical, and fatal, with continuations |
| Request range    | 1–500 recent source lines                               |
| Authentication   | Dedicated 64-character hexadecimal bearer token         |
| Network exposure | Disabled until port 8099 is mapped manually             |
| Public access    | Never expose the app itself through Funnel or a router  |
| Gateway feature  | Optional and disabled by default                        |

## Architecture

```text
ChatGPT
   │ HTTPS
   ▼
HA ChatGPT Gateway
   │ trusted LAN + dedicated bearer token
   ▼
HA ChatGPT Diagnostics
   │ fixed Supervisor request  GET /core/logs
   ▼
Home Assistant Core logs
```

The public gateway never receives Supervisor credentials. Only the companion
app can reach the fixed Supervisor log endpoint.

## Before installing

The app requires `hassio_api: true` and `hassio_role: homeassistant`. Home
Assistant's `default` role cannot read `/core/logs`, and no narrower log-only
Supervisor role currently exists.

> **Residual permission risk:** The `homeassistant` role also technically
> authorizes other `/core/*` Supervisor operations, including state-changing
> lifecycle operations. This app never calls or proxies those operations, but
> compromise of its process or Supervisor token would have a larger impact than
> its public HTTP API suggests.

## Installation

During review, add the feature fork to **Settings → Apps → App store → ⋮ →
Repositories**:

```text
https://github.com/GitHub-Mac555/ha-chatgpt-gateway
```

After upstream publication, use the original project instead:

```text
https://github.com/aferende/ha-chatgpt-gateway
```

The repository metadata deliberately does not assign an app maintainer. A
maintainer and long-term publication process remain decisions for the upstream
project owner.

For local testing, copy only the `ha-chatgpt-diagnostics` directory to
`/addons/ha-chatgpt-diagnostics` and reload the app store. In every installation
mode, keep protection mode enabled.

## Configuration

### 1. Create a dedicated token

Generate a new token on a trusted machine:

```bash
openssl rand -hex 32
```

Do not reuse a Home Assistant token or the gateway API key. Paste the result
into `diagnostics_token`, save it, and never post it in screenshots, chats,
issues, or logs.

| Option              | Required | Description                                                                |
| ------------------- | -------- | -------------------------------------------------------------------------- |
| `diagnostics_token` | Yes      | Exactly 64 hexadecimal characters; used only between gateway and companion |

### 2. Map the network port

Under **Network**, enter host port `8099` in the empty field next to
`8099/tcp`, then save.

The mapping is disabled by default. Permit port 8099 only from the trusted
Raspberry Pi gateway. Do not expose it through a router port-forward, Home
Assistant ingress, or Tailscale Funnel.

The connection uses plain HTTP on the trusted LAN because Home Assistant app
port mappings do not provide app-managed TLS. Anyone able to sniff that path
could observe the bearer token and returned logs. Use an isolated LAN/VLAN or
private overlay if this is unacceptable.

### 3. Start the app

Start the app and open **Protocol**. A successful start looks like this:

```text
2026-09-05T07:45:12.123Z INFO Diagnostics app started version=0.1.10
2026-09-05T07:45:12.137Z INFO Configuration loaded
2026-09-05T07:45:12.140Z INFO Privileges dropped uid=1000 gid=1000
2026-09-05T07:45:12.168Z INFO Diagnostics API listening host=0.0.0.0 port=8099
```

Tokens, authorization headers, and returned Home Assistant log content are
never written to this protocol. Lifecycle and result metadata use compact
English messages with ISO-8601 timestamps in UTC.

## API reference

| Route                               | Authentication | Result                                                  |
| ----------------------------------- | -------------- | ------------------------------------------------------- |
| `GET /health`                       | None           | Minimal liveness response                               |
| `GET /api/v1/logs/errors?lines=100` | Bearer token   | Bounded warning/error records with continuation context |

`lines` defaults to 100 and must be an integer from 1 through 500. Duplicate
limits, unknown parameters, paths, source selectors, and expressions are
rejected. The app never follows logs. Directly following traceback and other
continuation lines remain attached to a selected warning/error record until a
new log record begins. A new info/debug record is not included.

## Security boundaries

- The source, Supervisor host, HTTP method, and path are constants.
- Caller-controlled URLs, filenames, grep expressions, and shell input do not
  exist.
- The protected route is limited to 30 requests per source address per 60
  seconds.
- Upstream and downstream responses have strict line, byte, and per-line caps.
- Supervisor requests time out after 10 seconds.
- Responses use `Cache-Control: no-store`.
- The app and gateway redact common authorization values, access tokens,
  passwords, JWTs, webhook secrets, credential-bearing URLs, and sensitive
  query parameters.
- The app has no generic proxy, shell, Docker socket, host network, ingress, or
  filesystem mounts.

Tracebacks can contain more sensitive context than a single record header.
Every retained continuation line is therefore redacted before return and
remains subject to the same line, per-line, and total-response byte caps. An
oversized record is truncated without bypassing those limits.

Regex redaction is defense in depth and cannot guarantee removal of every
secret from arbitrary text. Authentication, fixed scope, small windows,
severity filtering, response caps, and network isolation are the primary
disclosure controls.

## Direct companion test

Run this from the trusted Raspberry Pi gateway. The token is entered silently
and removed from the shell variable afterward:

```bash
curl --fail http://<home-assistant-lan-ip>:8099/health

read -rsp 'Diagnostics token: ' DIAGNOSTICS_TEST_TOKEN; echo
curl --fail-with-body \
  -H "Authorization: Bearer $DIAGNOSTICS_TEST_TOKEN" \
  'http://<home-assistant-lan-ip>:8099/api/v1/logs/errors?lines=10'
unset DIAGNOSTICS_TEST_TOKEN
```

Expected behavior:

| Test                     | Expected result                                              |
| ------------------------ | ------------------------------------------------------------ |
| Health                   | HTTP 200 and `status: ok`                                    |
| Correct token            | HTTP 200 with bounded Core warning/error records and context |
| Missing or wrong token   | HTTP 401                                                     |
| `lines=0` or `lines=501` | HTTP 400                                                     |

Inspect returned logs only in a trusted local terminal. Do not paste raw Home
Assistant logs into chats, issues, or screenshots.

## Connect a separate test gateway

Keep production on `127.0.0.1:8787`. Build this branch in a separate directory
and run the feature gateway only on `127.0.0.1:8788` with:

```env
PORT=8788
ENABLE_ERROR_LOGS=true
DIAGNOSTICS_ADDON_URL=http://<home-assistant-lan-ip>:8099
DIAGNOSTICS_ADDON_TOKEN=<same-dedicated-64-hex-token>
```

Retain the existing Home Assistant URL, read-only mode, authentication, and
entity/domain policy. The test deployment must use a mode-600 environment file
and the Docker port binding `127.0.0.1:8788:8788`.

Test locally:

```bash
curl --fail http://127.0.0.1:8788/health
curl --silent http://127.0.0.1:8788/openapi.json \
  | grep -F /api/v1/logs/errors

read -rsp 'Gateway read key: ' GATEWAY_TEST_KEY; echo
curl --fail-with-body \
  -H "Authorization: Bearer $GATEWAY_TEST_KEY" \
  'http://127.0.0.1:8788/api/v1/logs/errors?lines=10'
unset GATEWAY_TEST_KEY
```

Also verify HTTP 401 without the gateway key, HTTP 400 for invalid limits, and
HTTP 503 while only the diagnostics app is temporarily offline.

## Troubleshooting

| Symptom                        | Check                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| App immediately stops          | Confirm `diagnostics_token` contains exactly 64 hexadecimal characters |
| No Save button for port        | Enter `8099` in the empty field to the left of `8099/tcp`              |
| Health endpoint is unreachable | Confirm the app is running and port 8099 is mapped                     |
| Protected route returns 401    | Confirm both components use the same dedicated diagnostics token       |
| Protected route returns 503    | Check that the app is running and Supervisor access is available       |
| No lines are returned          | The selected recent window may contain no warning/error records        |
| Gateway route is missing       | Set `ENABLE_ERROR_LOGS=true` only on the separate feature gateway      |

## Cleanup after testing

1. Remove the temporary Funnel route, if one was explicitly created.
2. Stop and remove only the separate gateway test deployment.
3. Disable the app's host port mapping or stop the app when it is not needed.
4. Securely remove temporary environment copies and diagnostics tokens.
5. Confirm production remains healthy on `http://127.0.0.1:8787/health`.
