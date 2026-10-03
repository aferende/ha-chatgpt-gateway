import { registerGatewayAction } from '../http/actions.js';
import type { FastifyInstance } from 'fastify';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import type { HomeAssistantServiceDefinition } from '../home-assistant/types.js';
import { z } from 'zod';
import { invalidRequest } from '../http/errors.js';
import { isEntityAllowed } from '../security/authorization.js';
import { isAdminActionAllowed } from '../security/admin-actions.js';

const serviceQuerySchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(128)
    .transform((value) => value.toLowerCase())
    .optional(),
});

const serviceParamsSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+$/i)
    .transform((value) => value.toLowerCase()),
  service: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_]+$/i)
    .transform((value) => value.toLowerCase()),
});

function toServiceContract(
  domain: string,
  service: string,
  definition: HomeAssistantServiceDefinition,
) {
  return {
    domain,
    service,
    name: definition.name,
    description: definition.description,
    target: definition.target ?? {},
    response: definition.response,
    fields: Object.entries(definition.fields ?? {}).map(([name, field]) => ({
      name,
      description: field.description,
      required: field.required ?? false,
      example: field.example,
      selector: field.selector,
    })),
  };
}

function isServiceDiscoverable(config: GatewayConfig, domain: string, service: string): boolean {
  return config.allowedDomains.has(domain) || isAdminActionAllowed(config, domain, service);
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: HomeAssistantClient,
): Promise<void> {
  registerGatewayAction(app, 'GET', '/api/v1/config', async () => {
    const haConfig = await client.getConfig();
    return {
      home_assistant: {
        location_name: haConfig.location_name,
        time_zone: haConfig.time_zone,
        version: haConfig.version,
        state: haConfig.state,
        unit_system: haConfig.unit_system,
      },
      gateway: {
        read_only: config.readOnly,
        allowed_domains: [...config.allowedDomains].sort(),
        entity_allowlist_enabled: config.allowedEntities.size > 0,
        async_service_dispatch_enabled: config.asyncServiceDispatchEnabled,
        admin_actions_enabled: config.adminActionsEnabled,
        admin_allowed_actions: [...config.adminAllowedActions].sort(),
      },
    };
  });

  registerGatewayAction(app, 'GET', '/api/v1/services', async (request, reply) => {
    const parsedQuery = serviceQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send(invalidRequest(parsedQuery.error.issues));
    }
    const requestedDomain = parsedQuery.data.domain;
    const services = await client.getServices();

    if (
      requestedDomain &&
      !services.some(
        ({ domain, services: domainServices }) =>
          domain.toLowerCase() === requestedDomain &&
          Object.keys(domainServices).some((service) =>
            isServiceDiscoverable(config, domain.toLowerCase(), service),
          ),
      )
    ) {
      return reply.code(403).send({ error: 'forbidden', message: 'Domain is not allowed.' });
    }

    return {
      domains: services
        .map(({ domain, services: domainServices }) => ({
          domain,
          services: Object.fromEntries(
            Object.entries(domainServices).filter(([service]) =>
              isServiceDiscoverable(config, domain.toLowerCase(), service),
            ),
          ),
        }))
        .filter(({ services: domainServices }) => Object.keys(domainServices).length > 0)
        .filter(({ domain }) => !requestedDomain || domain.toLowerCase() === requestedDomain),
    };
  });

  registerGatewayAction(app, 'GET', '/api/v1/services/:domain/:service', async (request, reply) => {
    const parsedParams = serviceParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send(invalidRequest(parsedParams.error.issues));
    }

    const { domain, service } = parsedParams.data;
    if (!isServiceDiscoverable(config, domain, service)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Domain is not allowed.' });
    }

    const services = await client.getServices();
    const serviceDomain = services.find(
      ({ domain: candidate }) => candidate.toLowerCase() === domain,
    );
    const definition = serviceDomain?.services[service];
    if (!definition) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'The requested Home Assistant service was not found.',
      });
    }

    return { service: toServiceContract(domain, service, definition) };
  });

  registerGatewayAction(app, 'GET', '/api/v1/diagnostics', async () => {
    const startedAt = Date.now();
    const haConfig = await client.getConfig();
    return {
      status: 'ok',
      home_assistant: {
        reachable: true,
        version: haConfig.version,
        state: haConfig.state,
        response_ms: Date.now() - startedAt,
      },
      gateway: {
        read_only: config.readOnly,
        rate_limit_enabled: config.rateLimitMax > 0,
      },
    };
  });

  registerGatewayAction(app, 'GET', '/api/v1/areas', async () => {
    const [areas, devices, entities] = await Promise.all([
      client.getAreas(),
      client.getDevices(),
      client.getEntityRegistry(),
    ]);
    const allowedDeviceIds = new Set(
      entities
        .filter((entity) => isEntityAllowed(config, entity.entity_id))
        .flatMap((entity) => (entity.device_id ? [entity.device_id] : [])),
    );
    const allowedAreaIds = new Set(
      entities
        .filter((entity) => isEntityAllowed(config, entity.entity_id))
        .flatMap((entity) => (entity.area_id ? [entity.area_id] : [])),
    );
    for (const device of devices) {
      if (allowedDeviceIds.has(device.id) && device.area_id) {
        allowedAreaIds.add(device.area_id);
      }
    }
    return {
      areas: areas
        .filter((area) => allowedAreaIds.has(area.area_id))
        .map((area) => ({ area_id: area.area_id, name: area.name, aliases: area.aliases ?? [] })),
    };
  });

  registerGatewayAction(app, 'GET', '/api/v1/devices', async () => {
    const [devices, entities] = await Promise.all([
      client.getDevices(),
      client.getEntityRegistry(),
    ]);
    const allowedDeviceIds = new Set(
      entities
        .filter((entity) => isEntityAllowed(config, entity.entity_id))
        .flatMap((entity) => (entity.device_id ? [entity.device_id] : [])),
    );
    return {
      devices: devices
        .filter((device) => allowedDeviceIds.has(device.id))
        .map((device) => ({
          id: device.id,
          area_id: device.area_id ?? null,
          name: device.name_by_user ?? device.name ?? null,
          manufacturer: device.manufacturer ?? null,
          model: device.model ?? null,
        })),
    };
  });
}
