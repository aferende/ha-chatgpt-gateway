import { registerGatewayAction } from '../http/actions.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import { entityParamsSchema } from '../schemas/entity.js';
import { getEntityDomain, isDomainAllowed, isEntityAllowed } from '../security/authorization.js';
import { invalidRequest } from '../http/errors.js';

const entityQuerySchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(128)
    .transform((value) => value.toLowerCase())
    .optional(),
  name: z
    .string()
    .min(1)
    .max(256)
    .transform((value) => value.toLowerCase())
    .optional(),
  state: z
    .string()
    .min(1)
    .max(256)
    .transform((value) => value.toLowerCase())
    .optional(),
  device_class: z
    .string()
    .min(1)
    .max(128)
    .transform((value) => value.toLowerCase())
    .optional(),
});

function toDiscoveryEntity(state: {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}) {
  const relevantAttributeKeys = [
    'device_class',
    'unit_of_measurement',
    'supported_features',
    'brightness',
    'color_mode',
    'current_temperature',
    'temperature',
    'hvac_action',
    'hvac_modes',
    'fan_modes',
    'swing_modes',
    'preset_modes',
    'min_temp',
    'max_temp',
    'target_temp_step',
    'temperature_unit',
    'current_position',
    'assumed_state',
  ];
  const attributes = Object.fromEntries(
    relevantAttributeKeys
      .filter((key) => key in state.attributes)
      .map((key) => [key, state.attributes[key]]),
  );

  return {
    entity_id: state.entity_id,
    friendly_name:
      typeof state.attributes.friendly_name === 'string'
        ? state.attributes.friendly_name
        : state.entity_id,
    domain: getEntityDomain(state.entity_id),
    state: state.state,
    attributes,
    last_changed: state.last_changed,
    last_updated: state.last_updated,
  };
}

export async function registerEntityRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: HomeAssistantClient,
): Promise<void> {
  registerGatewayAction(app, 'GET', '/api/v1/entities', async (request, reply) => {
    const queryResult = entityQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send(invalidRequest(queryResult.error.issues));
    }

    const domain = queryResult.data.domain;
    if (domain && !isDomainAllowed(config, domain)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Domain is not allowed.' });
    }

    const states = await client.getStates();
    const entities = states.filter((state) => {
      if (!isEntityAllowed(config, state.entity_id)) {
        return false;
      }
      const friendlyName = String(state.attributes.friendly_name ?? state.entity_id).toLowerCase();
      const deviceClass = String(state.attributes.device_class ?? '').toLowerCase();
      return (
        (!domain || getEntityDomain(state.entity_id) === domain) &&
        (!queryResult.data.name || friendlyName.includes(queryResult.data.name)) &&
        (!queryResult.data.state || state.state.toLowerCase() === queryResult.data.state) &&
        (!queryResult.data.device_class || deviceClass === queryResult.data.device_class)
      );
    });

    return { entities: entities.map(toDiscoveryEntity) };
  });

  registerGatewayAction(app, 'GET', '/api/v1/entities/:entityId', async (request, reply) => {
    const paramsResult = entityParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send(invalidRequest(paramsResult.error.issues));
    }

    const { entityId } = paramsResult.data;
    if (!isEntityAllowed(config, entityId)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Entity is not allowed.' });
    }

    return client.getState(entityId);
  });

  registerGatewayAction(app, 'GET', '/api/v1/entities/:entityId/state', async (request, reply) => {
    const paramsResult = entityParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: paramsResult.error.issues });
    }

    const { entityId } = paramsResult.data;
    if (!isEntityAllowed(config, entityId)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Entity is not allowed.' });
    }

    const state = await client.getState(entityId);
    return {
      entity_id: state.entity_id,
      state: state.state,
      last_changed: state.last_changed,
      last_updated: state.last_updated,
    };
  });
}
