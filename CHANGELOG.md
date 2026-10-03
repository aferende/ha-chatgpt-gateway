# Changelog

## v0.7.0 — Home Assistant ChatGPT Gateway Plugin

### Breaking integration change

- Replaces the primary custom GPT/OpenAPI Action setup with a personal MCP plugin and standard self-hosted Keycloak authentication. API keys are not OAuth plugin credentials.
- New example installations are MCP-only; legacy REST/OpenAPI remain available with `ENABLE_LEGACY_REST_API=true` for backward compatibility.

- Adds opt-in stateless MCP Streamable HTTP and a portable plugin/skill package, retaining REST and sharing the existing action handlers.
- Adds OAuth resource metadata, JWT/JWKS verification and authenticated opaque-token introspection, plus a fail-closed setup-only mode.
- Preserves entity policies, batches, service limits and asynchronous semantics; binds dispatch status to the creating identity.
- Standardizes plugin authentication on the included Keycloak/PostgreSQL stack, with a preregistered confidential PKCE client and separate read/write roles.
- Documents Keycloak bootstrap, callback registration and the official custom GPT retirement dates.
- Supports ChatGPT's `openid offline_access read write` request through an optional offline scope and an explicitly authorized offline role, with regression coverage ensuring offline access cannot confer write privileges.
- Explicitly imports and assigns Keycloak's basic subject mapper for human tokens, preventing successful OAuth login followed by unauthorized MCP discovery; signed tokens without a subject remain rejected.
- Adds MCP-only operation without REST credentials, reviewed retirement/rollback instructions, a reusable skill, a technology-style icon and updated workflow illustrations.
- Retains non-root/read-only Docker hardening and exact Home Assistant authorization policy. Real NAS and ChatGPT acceptance preceded release preparation.
- Builds TypeScript on the native builder platform to avoid ARM64 Node/QEMU failures during dependency installation; rejects native runtime addons before cross-platform packaging.

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
