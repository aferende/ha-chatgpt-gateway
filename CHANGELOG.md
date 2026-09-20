# Changelog

## Unreleased

## v0.6.0 — Diagnostics and forensic observability

### Added

- Adds opt-in, policy-filtered Home Assistant Logbook access with bounded time ranges, response limits, and state minimization.
- Adds an optional Home Assistant Diagnostics companion and an opt-in gateway route for bounded, redacted Home Assistant Core warning/error records with traceback and continuation context.
- Adds structured, privacy-preserving request completion audit events with server-generated request IDs and HMAC-based pseudonymous client/peer fingerprints.
- Correlates gateway-to-Diagnostics requests with a shared validated request ID and documents forensic analysis, privacy boundaries, retention, and incident handling.

### Security

- Separates failed-authentication, authenticated, and service-call rate-limit buckets so invalid authentication attempts cannot consume authenticated quota.
- Bounds process-local rate-limit maps and preserves independent credential identities for legacy, read, and write keys.
- Keeps raw IP logging disabled by default; optional persistent audit HMAC keys allow stable pseudonyms across restarts without reusing API credentials.
- Keeps Supervisor credentials and Core log content out of gateway audit events and exposes no generic Supervisor, filesystem, shell, or log-source proxy.
- Raises the declared Fastify runtime dependency floor to 5.12.5 and aligns the project Node.js requirement with the current test toolchain.

### Fixed

- Accepts ISO-8601 History and Logbook timestamps with encoded or narrowly repaired raw positive UTC offsets without broadly rewriting query values.
- Keeps optional Logbook and Core-error-log OpenAPI operation descriptions within ChatGPT's 300-character import limit and adds regression coverage.
- Preserves distinct `legacy`, `read`, and `write` credential identities for audit attribution and independent authenticated/service rate-limit buckets.
- Makes Diagnostics lifecycle and request audit logs compact and human-readable while retaining correlation and rate-limit metadata.

## v0.5.0 — Long-running automations and opt-in administration

### Added

- Adds opt-in asynchronous dispatch for selected entity-targeted domains, so long-running automations and scripts can return promptly with a trackable dispatch status.
- Adds a separate opt-in administration endpoint for an exact allow-list of safe maintenance actions, including Home Assistant configuration checks, reloads, and restart.
- Adds an independent timeout for synchronous service calls and a bounded timeout/concurrency limit for asynchronous dispatches.

### Fixed

- Prevents long-running Home Assistant automations from being reported as unavailable solely because they exceed the read-request timeout.

## v0.4.5 — GPT Action schema compatibility

### Fixed

- Shortens GPT Action operation descriptions to comply with ChatGPT's 300-character import limit.
- Adds regression coverage that prevents future OpenAPI operation descriptions from exceeding that limit.

## v0.4.4 — Home Assistant service responses

### Fixed

- Automatically requests Home Assistant response data for services that require it, such as weather forecasts and calendar event queries.
- Includes live response capability metadata in service contracts without changing the public target policy.

## v0.4.3 — Structured GPT Action service data

### Fixed

- Exposes Home Assistant service parameters as a structured `data` object in the GPT Action OpenAPI schema.
- Supports the same structured data in ordered service batches, including a single call that targets multiple compatible entities.
- Keeps the legacy `data_json` form for existing REST clients and imported Actions, while documenting `data` as the GPT Action format.

## v0.4.2 — Proxy-aware rate limiting

### Security

- Adds explicit trusted-proxy configuration for correct per-client rate limiting behind reverse proxies.
- Prevents untrusted clients from influencing rate-limit identity through forwarded IP headers.
- Adds regression coverage for proxy-aware authentication throttling and independent client buckets.

## v0.4.1 — Security hardening

- Runs the general protected-route rate limiter before authentication, so failed authentication attempts are limited.
- Requires every configured gateway credential to be a distinct, exactly 64-character hexadecimal key generated from 32 random bytes.
- Refuses to start write-enabled deployments without an explicit `ALLOWED_ENTITIES` allow-list.
- Adds security regression tests for these controls.
