# Forensic observability

## Architecture and trust boundaries

The public flow is `Internet client -> HTTPS proxy/Funnel -> gateway`. The
private diagnostics flow is `gateway -> trusted LAN/private overlay -> HA
ChatGPT Diagnostics -> Supervisor /core/logs`. Home Assistant and the companion
must not be exposed publicly. The gateway remains the public authentication and
authorization boundary.

The TCP peer and resolved client are different concepts. `peer_fingerprint`
represents the socket peer; `client_fingerprint` represents Fastify's
`request.ip`. `trusted_proxy_used=true` means Fastify used a forwarding chain
through explicitly configured trusted proxy peers. Forwarded headers from other
peers are ignored.

If `TRUSTED_PROXIES` is empty behind Funnel, all Internet clients can appear as
one proxy IP. If it is too broad, an untrusted sender may spoof a forwarding
header. Configure only verified proxy peer IPs or narrow CIDRs.

The companion normally sees every legitimate request as the gateway's single
LAN address. Its `source_fingerprint` therefore identifies a network peer, not
an end user. The gateway request ID supplies cross-process correlation.

## Rate limiters and bucket construction

All limiters are lightweight, bounded, process-local maps:

| Component | Scope                       | Bucket                             | Counted requests                                        |
| --------- | --------------------------- | ---------------------------------- | ------------------------------------------------------- |
| Gateway   | `gateway_pre_auth`          | resolved client IP                 | missing, malformed, or invalid authentication           |
| Gateway   | `gateway_authenticated`     | credential ID + resolved client IP | successfully authenticated requests                     |
| Gateway   | `gateway_service`           | credential ID + resolved client IP | service writes, in addition to the authenticated limit  |
| Companion | `diagnostics_pre_auth`      | socket peer address                | missing, malformed, or invalid companion authentication |
| Companion | `diagnostics_authenticated` | socket peer address                | successfully authenticated log requests                 |

Previously, the gateway counted every protected request in one IP bucket before
authentication. A scanner could consume a legitimate client's quota when both
had the same visible IP. The companion likewise counted all requests from its
socket peer before token validation. The separated model prevents invalid
requests from consuming authenticated quota while retaining a cheap failed-auth
limiter. Configured limits and windows do not change.

Gateway maps hold at most 4096 buckets per limiter; companion maps hold at most 1024. Expired entries are removed at capacity, followed by bounded oldest-entry
eviction if necessary. All counts disappear on restart. A 429 immediately after
restart cannot be explained by prior in-process state.

## Request ID correlation

The gateway generates a UUID for every request and returns it as `X-Request-ID`.
It does not trust an Internet-supplied ID. For a diagnostics call, the gateway
forwards its internal ID to the companion. The companion accepts it only when it
has a valid UUID shape; otherwise it generates a new UUID. Match `request_id` in
the gateway `request_completed` event to the companion
`diagnostics_request_completed` event.

## Audit fields and events

The gateway emits one Pino JSON `request_completed` event per protected request.
The companion emits one JSON `diagnostics_request_completed` event per protected
log request. Status 401, 429, and 5xx events use warning level; normal and 4xx
validation results use info. Fields include:

- UTC `timestamp`, `request_id`, method, canonical route, status, and duration;
- `auth_outcome`: `missing`, `malformed`, `invalid`, or `authenticated`;
- gateway `credential_id` only after successful authentication;
- limiter scope, decision, limit, count, remaining, and reset time;
- pseudonymous client/peer/source fingerprints and proxy-use state;
- a maximum-200-character User-Agent in gateway events, with controls removed;
- `requested_lines` in companion events only after it is valid.

Gateway events store records in `rate_limits` because service requests can have
both authenticated and service scopes. Companion events use flat
`rate_limit_*` fields.

Audit events never contain bearer values, Authorization headers, query strings,
request or response bodies, Home Assistant state values, returned Core log
content, Supervisor responses, or HMAC keys. Unexpected upstream failures are
represented only by status and safe error category.

## Privacy and retention

`AUDIT_LOG_ENABLED=true` is the gateway default. IPs are represented by the
first 96 bits of `HMAC-SHA256(address, AUDIT_HMAC_KEY)`. Generate the optional
key independently with `openssl rand -hex 32`; never derive it from a gateway or
diagnostics token. Without a configured key, a cryptographically random
process-local key is used and fingerprints cannot be compared across restarts.

Raw IP logging is off by default. `AUDIT_LOG_RAW_IPS=true` and companion
`audit_log_raw_ips: true` add personal data and should be enabled only for a
defined incident window, with restricted access and an explicit deletion date.

The applications do not maintain an audit database. Container, Supervisor, or
host logging controls retention. During an incident, preserve the relevant
bounded time range using the platform's access-controlled log export; do not
paste unreviewed logs into issues or chats.

## Interpreting 401 and 429

A 401 means authentication was missing, structurally malformed, or did not
match a configured credential. `auth_outcome` distinguishes these cases without
fingerprinting a bad token. A 429 identifies the exact limiter in its scope and
decision fields. `Retry-After` gives the remaining wait in seconds.

Many `invalid` events from client A followed by `gateway_pre_auth` blocks,
alongside allowed `gateway_authenticated` events for credential `write`, proves
that invalid attempts did not consume the write credential's quota. It does not
identify the person behind A.

If `peer_fingerprint` is constant while `client_fingerprint` varies and
`trusted_proxy_used=true`, client resolution behind the proxy is working. If
both stay identical for unrelated callers, check `TRUSTED_PROXIES` and proxy
forwarding. Logs cannot recover true identity when the proxy never supplied it,
prove attribution behind carrier NAT, or distinguish users sharing one
credential and IP.

## Incident checklist

1. Record gateway and companion start/restart times; limiter state resets then.
2. Preserve only the relevant host-managed JSON log window with restricted access.
3. Group gateway events by scope, decision, credential ID, and client fingerprint.
4. Compare client and peer fingerprints plus `trusted_proxy_used`.
5. Correlate diagnostics calls by `request_id` across both processes.
6. Confirm whether 401, 429, or 5xx events precede the reported failure.
7. Verify the exact proxy peer before changing `TRUSTED_PROXIES`.
8. Disable raw-IP logging again and apply the incident retention deadline.
9. Rotate a credential only if evidence indicates exposure; logs do not contain it.

## Manual integration test

Use a disposable local instance and environment variables for credentials; do
not put real values in shell history or screenshots. For History, call the same
five-minute absolute window using:

```text
start_time=2026-09-15T05:40:00Z&end_time=2026-09-15T05:45:00Z
start_time=2026-09-15T07:40:00%2B02:00&end_time=2026-09-15T07:45:00%2B02:00
start_time=2026-09-15T07:40:00+02:00&end_time=2026-09-15T07:45:00+02:00
start_time=2026-09-15T00:10:00-05:30&end_time=2026-09-15T00:15:00-05:30
```

Use a literal URL-capable client for the raw-plus case so it does not encode the
plus before transmission. Confirm all valid cases return 200 and equivalent UTC
bounds; invalid dates and ranges over 31 days must return 400.

For rate limiting, send valid requests until an authenticated 429 is produced,
record `Retry-After`, wait for the configured window, and confirm a later request
succeeds. Separately send invalid credentials until a pre-auth 429 occurs, then
confirm a valid credential still has an independent authenticated count. Inspect
only structured metadata, never bodies or headers.

For Diagnostics, make one valid gateway error-log request. Confirm the gateway
and companion completion events share `request_id`, use their authenticated
scopes, and contain neither the test token nor any returned Core log line.
Missing/wrong-token tests must run only from the trusted LAN; the companion must
remain absent from every public route and Funnel.
