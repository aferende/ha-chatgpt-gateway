# Changelog

## Unreleased

### Added

- Adds an optional Home Assistant diagnostics companion and an opt-in gateway route for bounded, redacted Home Assistant Core warning/error lines.
- Keeps bounded traceback and continuation context with selected warning/error records.

### Security

- Keeps Supervisor credentials out of the Internet-facing gateway and exposes no generic Supervisor, filesystem, shell, or log-source proxy.
- Applies the existing redaction and response bounds to every retained traceback line.

### Fixed

- Keeps optional Logbook and Core-error-log OpenAPI operation descriptions within ChatGPT's 300-character import limit and adds regression coverage.

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
