import type { GatewayConfig } from '../src/config/env.js';

export const TEST_GATEWAY_KEY = '0123456789abcdef'.repeat(4);

export function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 8787,
    homeAssistantUrl: 'http://homeassistant.local:8123',
    homeAssistantToken: 'ha-test-token',
    gatewayApiKey: TEST_GATEWAY_KEY,
    gatewayCredentials: [
      {
        id: 'legacy',
        key: TEST_GATEWAY_KEY,
        scopes: new Set(['read', 'write']),
      },
    ],
    allowedDomains: new Set(['light', 'switch']),
    allowedEntities: new Set(),
    readOnly: false,
    logbookEnabled: false,
    errorLogsEnabled: false,
    logLevel: 'silent',
    homeAssistantTimeoutMs: 10_000,
    homeAssistantServiceTimeoutMs: 30_000,
    asyncServiceDispatchEnabled: false,
    asyncServiceDomains: new Set(),
    homeAssistantAsyncServiceTimeoutMs: 1_800_000,
    asyncServiceMaxConcurrent: 2,
    adminActionsEnabled: false,
    adminAllowedActions: new Set(),
    rateLimitMax: 0,
    rateLimitWindowMs: 60_000,
    serviceRateLimitMax: 0,
    serviceRateLimitWindowMs: 60_000,
    trustedProxies: [],
    ...overrides,
  };
}

export const sampleStates = [
  {
    entity_id: 'light.living_room',
    state: 'on',
    attributes: { friendly_name: 'Living room' },
    last_changed: '2026-08-15T10:00:00+00:00',
    last_updated: '2026-08-15T10:00:00+00:00',
  },
  {
    entity_id: 'switch.coffee_machine',
    state: 'off',
    attributes: { friendly_name: 'Coffee machine' },
    last_changed: '2026-08-15T10:00:00+00:00',
    last_updated: '2026-08-15T10:00:00+00:00',
  },
  {
    entity_id: 'lock.front_door',
    state: 'locked',
    attributes: { friendly_name: 'Front door' },
    last_changed: '2026-08-15T10:00:00+00:00',
    last_updated: '2026-08-15T10:00:00+00:00',
  },
];
