import { APP_VERSION } from '../version.js';

const errorResponses = {
  '400': { description: 'Invalid request' },
  '401': { description: 'Missing or invalid gateway API key' },
  '403': { description: 'Blocked by gateway policy' },
  '429': { description: 'Rate limit exceeded' },
  '502': { description: 'Home Assistant returned an unexpected response' },
  '503': { description: 'Home Assistant is unavailable or timed out' },
};

const entityIdParameter = {
  name: 'entityId',
  in: 'path',
  required: true,
  schema: { type: 'string', examples: ['light.living_room'] },
};

export interface OpenApiFeatureFlags {
  logbookEnabled?: boolean;
  errorLogsEnabled?: boolean;
}

export function buildOpenApiSchema(publicBaseUrl?: string, features: OpenApiFeatureFlags = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HA ChatGPT Gateway',
      version: APP_VERSION,
      description:
        'A policy-enforced self-hosted REST gateway for a ChatGPT GPT Action. Use only this API; never send Home Assistant credentials to it.',
    },
    ...(publicBaseUrl ? { servers: [{ url: publicBaseUrl }] } : {}),
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          operationId: 'getGatewayHealth',
          summary: 'Check gateway liveness',
          security: [],
          responses: { '200': { description: 'Gateway is running' } },
        },
      },
      '/api/v1/config': {
        get: {
          operationId: 'getHomeAssistantConfig',
          summary: 'Get safe Home Assistant and gateway configuration',
          responses: { '200': { description: 'Safe configuration summary' }, ...errorResponses },
        },
      },
      '/api/v1/diagnostics': {
        get: {
          operationId: 'getGatewayDiagnostics',
          summary: 'Check authenticated connectivity to Home Assistant',
          responses: { '200': { description: 'Connectivity diagnostics' }, ...errorResponses },
        },
      },
      ...(features.logbookEnabled
        ? {
            '/api/v1/logbook': {
              get: {
                operationId: 'getHomeAssistantLogbook',
                summary: 'Get bounded Home Assistant logbook entries for allowed entities',
                description:
                  'Read Home Assistant logbook events for troubleshooting. This opt-in endpoint is authenticated and rate-limited, filters by gateway entity policy, returns at most 500 entries, allows 24 hours unscoped or 7 days for an allowed entity_id, redacts data, and omits state values by default.',
                parameters: [
                  {
                    name: 'start_time',
                    in: 'query',
                    required: true,
                    schema: {
                      type: 'string',
                      format: 'date-time',
                      examples: ['2026-09-01T00:00:00Z'],
                    },
                  },
                  {
                    name: 'end_time',
                    in: 'query',
                    schema: {
                      type: 'string',
                      format: 'date-time',
                      examples: ['2026-09-02T00:00:00Z'],
                    },
                  },
                  {
                    name: 'entity_id',
                    in: 'query',
                    schema: { type: 'string', examples: ['sensor.office_temperature'] },
                  },
                  {
                    name: 'limit',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
                  },
                  {
                    name: 'include_state',
                    in: 'query',
                    description:
                      'Include Home Assistant state values in logbook entries. Defaults to false to minimize disclosure of IP addresses, URLs, and other potentially sensitive state data.',
                    schema: { type: 'boolean', default: false },
                  },
                ],
                responses: {
                  '200': { description: 'Allowed redacted logbook entries' },
                  ...errorResponses,
                },
              },
            },
          }
        : {}),
      ...(features.errorLogsEnabled
        ? {
            '/api/v1/logs/errors': {
              get: {
                operationId: 'getHomeAssistantErrorLogs',
                summary: 'Get bounded Home Assistant Core warning and error records',
                description:
                  'Read Home Assistant Core warning/error records and bounded traceback context through the optional diagnostics companion. The authenticated, rate-limited endpoint accepts 1 to 500 recent source lines and applies best-effort secret redaction.',
                parameters: [
                  {
                    name: 'lines',
                    in: 'query',
                    schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
                  },
                ],
                responses: {
                  ...errorResponses,
                  '200': {
                    description: 'Redacted Home Assistant Core warning/error records and context',
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          properties: {
                            source: { type: 'string', const: 'home_assistant_core' },
                            requested_lines: { type: 'integer', minimum: 1, maximum: 500 },
                            returned_lines: { type: 'integer', minimum: 0, maximum: 500 },
                            truncated: { type: 'boolean' },
                            entries: {
                              type: 'array',
                              maxItems: 500,
                              items: { type: 'string', maxLength: 24576 },
                            },
                          },
                          required: [
                            'source',
                            'requested_lines',
                            'returned_lines',
                            'truncated',
                            'entries',
                          ],
                        },
                      },
                    },
                  },
                  '502': { description: 'Diagnostics companion returned an unexpected response' },
                  '503': { description: 'Diagnostics companion is unavailable or timed out' },
                },
              },
            },
          }
        : {}),
      '/api/v1/entities': {
        get: {
          operationId: 'listHomeAssistantEntities',
          summary: 'Discover allowed controllable entities',
          description:
            'Use filters to identify a device before reading it or calling an allowed service.',
          parameters: [
            { name: 'domain', in: 'query', schema: { type: 'string', examples: ['light'] } },
            { name: 'name', in: 'query', schema: { type: 'string', examples: ['living room'] } },
            { name: 'state', in: 'query', schema: { type: 'string', examples: ['on'] } },
            {
              name: 'device_class',
              in: 'query',
              schema: { type: 'string', examples: ['temperature'] },
            },
          ],
          responses: {
            '200': {
              description: 'Entities that satisfy the gateway policy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      entities: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DiscoveryEntity' },
                      },
                    },
                    required: ['entities'],
                  },
                },
              },
            },
            ...errorResponses,
          },
        },
      },
      '/api/v1/entities/{entityId}': {
        get: {
          operationId: 'getHomeAssistantEntity',
          summary: 'Get full state and attributes for one allowed entity',
          parameters: [entityIdParameter],
          responses: {
            '200': {
              description: 'Entity state',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/EntityState' } },
              },
            },
            '404': { description: 'Entity not found' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/entities/{entityId}/state': {
        get: {
          operationId: 'getHomeAssistantEntityState',
          summary: 'Get only current state and timestamps for one allowed entity',
          parameters: [entityIdParameter],
          responses: {
            '200': { description: 'Entity state summary' },
            '404': { description: 'Entity not found' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/entities/{entityId}/history': {
        get: {
          operationId: 'getHomeAssistantEntityHistory',
          summary: 'Get bounded history for one allowed entity',
          description:
            'Use for evidence-based analysis of one allowed sensor or entity. A start_time is required; the range is limited to 31 days and Home Assistant attributes are excluded.',
          parameters: [
            entityIdParameter,
            {
              name: 'start_time',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'date-time', examples: ['2026-08-01T00:00:00Z'] },
            },
            {
              name: 'end_time',
              in: 'query',
              schema: { type: 'string', format: 'date-time', examples: ['2026-08-08T00:00:00Z'] },
            },
            {
              name: 'max_points',
              in: 'query',
              schema: { type: 'integer', minimum: 2, maximum: 5000, default: 1000 },
            },
          ],
          responses: {
            '200': { description: 'Minimal state history for the requested entity' },
            '404': { description: 'Entity not found' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/automations/{entityId}': {
        get: {
          operationId: 'getHomeAssistantAutomationConfig',
          summary: 'Get redacted configuration for one allowed automation entity',
          description:
            'Use after discovering an allowed automation entity. Sensitive config values such as tokens, passwords, API keys, authorization values, and webhooks are redacted.',
          parameters: [entityIdParameter],
          responses: {
            '200': { description: 'Automation configuration with sensitive values redacted' },
            '404': { description: 'Automation configuration not found' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/areas': {
        get: {
          operationId: 'listHomeAssistantAreas',
          summary: 'List areas associated with allowed entities',
          description:
            'Area metadata comes from Home Assistant’s internal registry; only areas related to allowed entities are returned.',
          responses: { '200': { description: 'Allowed areas' }, ...errorResponses },
        },
      },
      '/api/v1/devices': {
        get: {
          operationId: 'listHomeAssistantDevices',
          summary: 'List devices associated with allowed entities',
          description:
            'Device metadata comes from Home Assistant’s internal registry; only devices related to allowed entities are returned.',
          responses: { '200': { description: 'Allowed devices' }, ...errorResponses },
        },
      },
      '/api/v1/services': {
        get: {
          operationId: 'listHomeAssistantServices',
          summary: 'Discover services available in allowed Home Assistant domains',
          description:
            'Use this for broad discovery. For a command with parameters, then read the precise service contract for the selected domain and service.',
          parameters: [
            { name: 'domain', in: 'query', schema: { type: 'string', examples: ['light'] } },
          ],
          responses: {
            '200': { description: 'Dynamic service definitions from Home Assistant' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/services/{domain}/{service}': {
        get: {
          operationId: 'getHomeAssistantServiceContract',
          summary: 'Get the live input contract for one allowed Home Assistant service',
          description:
            'Use before a parameterized command. The contract comes from Home Assistant and identifies supported fields, required fields, examples, selectors, and whether the service returns data.',
          parameters: [
            {
              name: 'domain',
              in: 'path',
              required: true,
              schema: { type: 'string', examples: ['climate'] },
            },
            {
              name: 'service',
              in: 'path',
              required: true,
              schema: { type: 'string', examples: ['set_temperature'] },
            },
          ],
          responses: {
            '200': {
              description: 'Live Home Assistant service contract',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { service: { $ref: '#/components/schemas/ServiceContract' } },
                    required: ['service'],
                  },
                },
              },
            },
            '404': { description: 'Service not found' },
            ...errorResponses,
          },
        },
      },
      '/api/v1/services/call': {
        post: {
          operationId: 'callHomeAssistantService',
          summary: 'Call one allowed Home Assistant service for explicit allowed entities',
          description:
            'Disabled when READ_ONLY=true. Pass entity_id as an array, read the live contract first, then pass supported parameters in data. One call can target compatible explicit entities. Global, device, area, and label targets are rejected.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ServiceCall' } },
            },
          },
          responses: {
            '200': { description: 'Service call completed' },
            '202': {
              description: 'Long-running service call queued for asynchronous completion',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      accepted: { type: 'boolean' },
                      dispatch: { $ref: '#/components/schemas/ServiceDispatch' },
                    },
                    required: ['ok', 'accepted', 'dispatch'],
                  },
                },
              },
            },
            ...errorResponses,
          },
        },
      },
      '/api/v1/services/batch': {
        post: {
          operationId: 'callHomeAssistantServiceBatch',
          summary: 'Run a short, ordered batch of allowed Home Assistant service calls',
          description:
            'Use for one clear request needing multiple services, such as HVAC mode, temperature, and fan mode. Validate contracts first. Calls run in order and stop on the first error. Batches are not transactional and cannot roll back completed calls.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ServiceBatch' } },
            },
          },
          responses: { '200': { description: 'All service calls completed' }, ...errorResponses },
        },
      },
      '/api/v1/service-dispatches/{dispatchId}': {
        get: {
          operationId: 'getHomeAssistantServiceDispatch',
          summary: 'Check an asynchronous Home Assistant service call',
          description:
            'Use after a service call returns 202. Queued means the gateway started the request; completed or failed is reported when Home Assistant finishes it.',
          parameters: [
            {
              name: 'dispatchId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Asynchronous service status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { dispatch: { $ref: '#/components/schemas/ServiceDispatch' } },
                    required: ['dispatch'],
                  },
                },
              },
            },
            ...errorResponses,
          },
        },
      },
      '/api/v1/admin/actions/call': {
        post: {
          operationId: 'callHomeAssistantAdminAction',
          summary: 'Call one explicitly enabled Home Assistant administration action',
          description:
            'Available only when ENABLE_ADMIN_ACTIONS=true and the exact action is in ADMIN_ALLOWED_ACTIONS. Use only for deliberate maintenance such as configuration checks, reloads, or restart.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AdminActionCall' } },
            },
          },
          responses: {
            '200': { description: 'Administration action completed' },
            ...errorResponses,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API key',
          description:
            'Use GATEWAY_WRITE_API_KEY when scoped credentials are configured, otherwise use the legacy GATEWAY_API_KEY. Do not use a Home Assistant token.',
        },
      },
      schemas: {
        EntityState: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            state: { type: 'string' },
            attributes: { type: 'object', additionalProperties: true },
            last_changed: { type: 'string' },
            last_updated: { type: 'string' },
          },
          required: ['entity_id', 'state', 'attributes', 'last_changed', 'last_updated'],
        },
        DiscoveryEntity: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            friendly_name: { type: 'string' },
            domain: { type: 'string' },
            state: { type: 'string' },
            attributes: { type: 'object', additionalProperties: true },
            last_changed: { type: 'string' },
            last_updated: { type: 'string' },
          },
          required: [
            'entity_id',
            'friendly_name',
            'domain',
            'state',
            'attributes',
            'last_changed',
            'last_updated',
          ],
        },
        ServiceCall: {
          type: 'object',
          properties: {
            domain: { type: 'string', examples: ['climate'] },
            service: { type: 'string', examples: ['set_temperature'] },
            entity_id: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string' },
              examples: [['climate.bedroom_air_conditioner']],
            },
            data_json: {
              type: 'string',
              description:
                'Legacy alternative to data: a JSON object encoded as a string. Prefer the structured data object for GPT Actions. Do not send both data and data_json.',
              examples: ['{"temperature":27}'],
            },
            data: {
              type: 'object',
              description:
                'Optional structured Home Assistant service parameters. Use only field names and values returned by getHomeAssistantServiceContract. Do not include entity_id, target, device_id, area_id, or label_id here.',
              additionalProperties: true,
              examples: [
                { hvac_mode: 'cool', temperature: 25, fan_mode: 'medium' },
                { brightness_pct: 50 },
              ],
            },
          },
          required: ['domain', 'service', 'entity_id'],
          additionalProperties: false,
        },
        ServiceBatch: {
          type: 'object',
          properties: {
            calls: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { $ref: '#/components/schemas/ServiceCall' },
              examples: [
                [
                  {
                    domain: 'climate',
                    service: 'set_hvac_mode',
                    entity_id: [
                      'climate.living_room_air_conditioner',
                      'climate.bedroom_air_conditioner',
                    ],
                    data: { hvac_mode: 'cool' },
                  },
                  {
                    domain: 'climate',
                    service: 'set_temperature',
                    entity_id: [
                      'climate.living_room_air_conditioner',
                      'climate.bedroom_air_conditioner',
                    ],
                    data: { temperature: 27 },
                  },
                  {
                    domain: 'climate',
                    service: 'set_fan_mode',
                    entity_id: [
                      'climate.living_room_air_conditioner',
                      'climate.bedroom_air_conditioner',
                    ],
                    data: { fan_mode: 'medium' },
                  },
                ],
              ],
            },
          },
          required: ['calls'],
          additionalProperties: false,
        },
        AdminActionCall: {
          type: 'object',
          properties: {
            domain: { type: 'string', examples: ['homeassistant'] },
            service: { type: 'string', examples: ['restart'] },
            data_json: {
              type: 'string',
              description: 'Legacy JSON-object string. Prefer data and do not send both.',
            },
            data: {
              type: 'object',
              description: 'Optional action parameters returned by the live service contract.',
              additionalProperties: true,
            },
          },
          required: ['domain', 'service'],
          additionalProperties: false,
        },
        ServiceDispatch: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'completed', 'failed'] },
            createdAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time' },
            error: { type: 'string' },
          },
          required: ['id', 'status', 'createdAt'],
        },
        ServiceContract: {
          type: 'object',
          properties: {
            domain: { type: 'string' },
            service: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            target: { type: 'object', additionalProperties: true },
            response: { type: 'object', additionalProperties: true },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  required: { type: 'boolean' },
                  example: {},
                  selector: { type: 'object', additionalProperties: true },
                },
                required: ['name', 'required'],
              },
            },
          },
          required: ['domain', 'service', 'fields'],
        },
      },
    },
  } as const;
}
