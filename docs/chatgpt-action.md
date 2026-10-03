# ChatGPT GPT and Action setup

**Legacy interface:** v0.7.0 uses the [MCP plugin and Keycloak](plugin-migration.md) as its primary integration. This guide applies only with `ENABLE_LEGACY_REST_API=true` and REST keys, which are not OAuth credentials. In MCP-only mode `/openapi.json` and the legacy API are absent.

This gateway is used by a **custom GPT**. It is not automatically available in every new ChatGPT conversation: start a chat with the GPT itself, or invoke that GPT where the ChatGPT interface supports it.

## Prerequisites

Before opening the GPT editor, verify all of the following from a network outside the home LAN:

1. The gateway is reachable via a public HTTPS hostname on standard port `443`.
2. `https://gateway.example.com/openapi.json` returns valid JSON and has a trusted TLS certificate.
3. `PUBLIC_BASE_URL=https://gateway.example.com` is set in the gateway `.env`, with no path and no port suffix.
4. The gateway starts with `READ_ONLY=true` and a deliberately small device policy.

ChatGPT Action clients require the OpenAPI `servers` origin to match the imported HTTPS origin. A URL such as `https://gateway.example.com:5153` can be rejected even when it works in a browser; use a reverse proxy on port `443` instead.

## Create the GPT Action

1. In ChatGPT on the web, open **Explore GPTs** and select **Create** (or edit an existing personal GPT).
2. Give the GPT a clear name and description, then open the **Configure** tab.
3. Under **Actions**, select **Create new action** / **Add action**.
4. Import this public URL:

   ```text
   https://gateway.example.com/openapi.json
   ```

   If the import button does not react, open the URL in a separate browser tab, copy the complete JSON document, and paste it into the schema editor. Do not edit the generated `servers` URL to a different hostname or port.

5. Keep the imported HTTP Bearer security scheme. Enter `GATEWAY_WRITE_API_KEY` when scoped keys are configured, otherwise use the legacy `GATEWAY_API_KEY`. Each configured gateway key must be a unique 64-character hexadecimal value generated with `openssl rand -hex 32`. If the UI calls it an API key, select the Bearer/Authorization option when offered. Enter the `Bearer ` prefix only when the UI explicitly asks for the full header value; otherwise enter the raw gateway key. A `GATEWAY_READ_API_KEY` is useful for a separate monitoring client but cannot call services.
6. Never enter `HOME_ASSISTANT_TOKEN` in ChatGPT. It belongs only in the gateway host's `.env` file.
7. Save or update the GPT.

The exact labels and available approval controls can differ by account and may change. ChatGPT can request approval before a state-changing Action. That approval is controlled by ChatGPT, not by this gateway; the gateway policy still applies even when an approval is granted.

## Paste these GPT Instructions (English)

Paste and adapt the following into the GPT's **Instructions** field. It deliberately tells the GPT to discover before acting and to treat ambiguous requests safely.

```text
You are a careful Home Assistant assistant. Use only the configured HA ChatGPT Gateway action for home information and control. Never claim that an action succeeded unless the action response confirms success.

Before controlling a device, discover the relevant entity and available service when they are not already known in the current conversation. Use areas and devices to resolve room requests, then act only on an explicit entity_id returned by the gateway.

For a parameterized command, first read the full entity state to identify its supported capabilities. Then call getHomeAssistantServiceContract for each intended service and use only the returned field names and supported values. Check whether the contract reports response capability for a data-returning service. Call callHomeAssistantService with entity_id as an array, even for one entity. Put service parameters in the structured data object. Do not put entity_id, target, area_id, device_id, or label_id inside data.

When one clear request requires multiple services, use callHomeAssistantServiceBatch only after discovering the contract for every service. Use an ordered batch for related steps such as setting HVAC mode, temperature, and fan mode. If the same service data is supported by several explicit entities, place them in one entity_id array; otherwise split them into separate compatible calls. A batch stops at the first error and cannot roll back an already completed call, so do not use it for unrelated or ambiguous changes.

Some services also expose entity-valued fields in their contract, such as a TTS output media player or members of a media-player group. Use only the exact field name and selector supplied by the contract. Every such entity is checked against the gateway policy. Do not try to use a service with no entity target: the gateway deliberately blocks global calls.

For evidence-based energy questions, discover the appliance's power and energy sensors, inspect only the relevant allowed automation configurations, and request the bounded history for each sensor using explicit ISO-8601 start and end times. Check total_points, returned_points, and sampled before interpreting the result. Base conclusions on kWh totals across comparable time periods; do not invent data or infer consumption from a single power spike.

For lighting requests, search both the light and switch domains: some physical lamps are represented as switches. Do not describe DND-mode or configuration entities as ordinary lights. Clearly mention unavailable entities instead of treating them as off.

For a request that could affect more than one device, summarize the exact target entities and ask a short clarification unless the user clearly named all intended devices. Do not issue domain-wide, area-wide, device-wide, label-wide, or target-less service calls.

Use the generic service discovery and service-call actions. If a service call returns HTTP 202 with a dispatch ID, say it has been queued, not completed. Use getHomeAssistantServiceDispatch only when a later status is needed. Automations and scripts may be configured for asynchronous dispatch because Home Assistant waits for long-running actions to finish.

Use callHomeAssistantAdminAction only when the user explicitly requests a maintenance action and the exact action was returned by service discovery. It is opt-in and only permits the gateway administrator's exact allow-list. Never request, reveal, store, or invent Home Assistant tokens or gateway API keys. Do not expose raw credentials in responses.

For state-changing actions, briefly state what you are going to do, call the action, then read the state again when useful and report the result. Treat locks, alarms, security devices, doors, gates, covers, heating, appliances, scripts, and scenes as high-impact: ask for explicit confirmation and do not attempt to bypass an unavailable or forbidden action.
```

## Recommended test sequence

1. Ask the GPT to check gateway health and safe configuration.
2. Ask it to list entities in `light`, then `switch`.
3. Ask it to read one chosen harmless device's state.
4. Ask it to list services for that device's domain, then retrieve one live service contract.
5. For an allowed sensor, request a short history interval and confirm the returned points are plausible.
6. For an allowed automation, read its redacted configuration and confirm that it contains no credential values.
7. With `READ_ONLY=true`, confirm that a write request is blocked.
8. Add a strict `ALLOWED_ENTITIES` list, change to `READ_ONLY=false`, and test one observed on/off action.
9. For a safe parameterized device, test one structured `data` service call with a documented field and re-read the state.
10. Re-read the state and check the container log if ChatGPT reports an ambiguous result.

## Troubleshooting

| Symptom                                       | Check                                                                                                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The schema import does nothing                | Open `/openapi.json` in another tab and paste its JSON into the editor. Verify the certificate and public reachability.                                                                                                                   |
| ChatGPT ignores the Action                    | Confirm the action is saved on the GPT you are actually chatting with; actions are not automatically available in ordinary chats.                                                                                                         |
| Server-origin warning                         | Set `PUBLIC_BASE_URL` to the exact public `https://hostname` origin and use port `443`; restart the gateway.                                                                                                                              |
| `401 unauthorized`                            | Re-enter the gateway API key in the Action. Do not use the Home Assistant token.                                                                                                                                                          |
| `403 forbidden`                               | Review `ALLOWED_DOMAINS`, `ALLOWED_ENTITIES`, and `READ_ONLY`.                                                                                                                                                                            |
| ChatGPT says a parameter is unavailable       | Re-import the latest `/openapi.json`, then ask the GPT to read the selected entity and `getHomeAssistantServiceContract` before issuing the command. Put the returned parameter in the structured `data` object, not at the request root. |
| A multi-setting HVAC request is incomplete    | The integration may expose separate services for mode, temperature, and fan speed. Ask the GPT to retrieve each contract and use one ordered `callHomeAssistantServiceBatch`.                                                             |
| A forecast or calendar query fails            | Re-import the current schema and retrieve the live service contract. The gateway automatically requests Home Assistant response data for response-only services.                                                                          |
| Automation reports Home Assistant unavailable | Enable asynchronous dispatch only for reviewed domains such as `automation,script`, re-import the schema, and retry. A `202` response means the request is queued; retrieve the dispatch status if needed.                                |
| ChatGPT asks before each write                | This is a ChatGPT approval policy. Where available, configure the connected app's permission in ChatGPT settings; some accounts/actions do not expose a persistent approval option.                                                       |
