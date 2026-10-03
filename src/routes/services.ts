import { registerGatewayAction } from '../http/actions.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import type { HomeAssistantServiceDomain } from '../home-assistant/types.js';
import {
  adminActionCallSchema,
  resolveServiceData,
  serviceBatchSchema,
  type AdminActionCallInput,
  serviceCallSchema,
  type ActionServiceCallInput,
  type ServiceCallInput,
} from '../schemas/service.js';
import { getEntityDomain, isDomainAllowed, isEntityAllowed } from '../security/authorization.js';
import {
  resolveServiceEntityTargets,
  type TargetResolutionFailure,
} from '../security/target-resolution.js';
import { invalidRequest } from '../http/errors.js';
import { hasGatewayScope } from '../security/authentication.js';
import { createServiceRateLimitHook } from '../security/rate-limit.js';
import { buildServiceTargetPolicy } from '../security/service-target-policy.js';
import { isAdminActionAllowed } from '../security/admin-actions.js';

type PreparedServiceCall = {
  domain: string;
  service: string;
  entity_id: string | string[];
  data?: Record<string, unknown>;
  returnResponse: boolean;
};

type ServiceDispatch = {
  id: string;
  status: 'queued' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  error?: 'home_assistant_error';
};

type ServiceInput = ServiceCallInput | ActionServiceCallInput;

function prepareAdminAction(
  input: AdminActionCallInput,
  config: GatewayConfig,
  client: HomeAssistantClient,
  services: HomeAssistantServiceDomain[],
): {
  call?: Omit<PreparedServiceCall, 'entity_id'>;
  statusCode?: number;
  error?: string;
  message?: string;
} {
  if (!isAdminActionAllowed(config, input.domain, input.service)) {
    return {
      statusCode: 403,
      error: 'forbidden',
      message: 'This Home Assistant administration action is not enabled.',
    };
  }

  const definition = client.getServiceDefinition(services, input.domain, input.service);
  if (!definition) {
    return {
      statusCode: 404,
      error: 'not_found',
      message: 'The requested Home Assistant service was not found.',
    };
  }

  const dataResult = resolveServiceData(input);
  if (dataResult.error) {
    return { statusCode: 400, error: 'invalid_request', message: dataResult.error };
  }

  return {
    call: {
      domain: input.domain,
      service: input.service,
      data: dataResult.data,
      returnResponse: definition.response?.optional === false,
    },
  };
}

function validateBasicServiceInput(
  input: ServiceInput,
  config: GatewayConfig,
): { statusCode?: number; error?: string; message?: string } {
  if (!isDomainAllowed(config, input.domain)) {
    return { statusCode: 403, error: 'forbidden', message: 'Domain is not allowed.' };
  }
  const dataResult = resolveServiceData(input);
  if (dataResult.error) {
    return { statusCode: 400, error: 'invalid_request', message: dataResult.error };
  }
  return {};
}

async function prepareServiceCall(
  input: ServiceInput,
  config: GatewayConfig,
  client: HomeAssistantClient,
  services: HomeAssistantServiceDomain[],
): Promise<{ call?: PreparedServiceCall; statusCode?: number; error?: string; message?: string }> {
  const basicValidation = validateBasicServiceInput(input, config);
  if (basicValidation.statusCode) return basicValidation;

  const definition = client.getServiceDefinition(services, input.domain, input.service);
  if (!definition) {
    return {
      statusCode: 404,
      error: 'not_found',
      message: 'The requested Home Assistant service was not found.',
    };
  }
  const targetPolicy = buildServiceTargetPolicy(input.domain, definition);
  if (targetPolicy.targetDomains.size === 0) {
    return {
      statusCode: 403,
      error: 'forbidden',
      message: 'This Home Assistant service does not have an explicit entity target.',
    };
  }

  const target = 'target' in input ? input.target : undefined;
  const unsupportedTargets = (['device_id', 'area_id', 'label_id'] as const).filter(
    (key) => target?.[key]?.length,
  );
  if (unsupportedTargets.length > 0) {
    return {
      statusCode: 403,
      error: 'forbidden',
      message: `Unsupported target type: ${unsupportedTargets.join(', ')}. Use explicit entity_id targets.`,
    };
  }

  const targetEntityIds = input.entity_id ?? target?.entity_id;
  if (!targetEntityIds) {
    return {
      statusCode: 403,
      error: 'forbidden',
      message: 'An explicit entity_id target is required by the gateway policy.',
    };
  }
  const entityIds = Array.isArray(targetEntityIds) ? targetEntityIds : [targetEntityIds];

  if (
    entityIds.some((entityId) => !targetPolicy.targetDomains.has(getEntityDomain(entityId) ?? ''))
  ) {
    return {
      statusCode: 400,
      error: 'invalid_request',
      message: 'One or more entity_id values are not valid targets for this service.',
    };
  }

  if (entityIds.some((entityId) => !isEntityAllowed(config, entityId))) {
    return {
      statusCode: 403,
      error: 'forbidden',
      message: 'One or more entities are not allowed.',
    };
  }

  const dataResult = resolveServiceData(input);

  const data = dataResult.data ? { ...dataResult.data } : undefined;
  for (const [fieldName, fieldPolicy] of targetPolicy.dataEntityFields) {
    if (!data) break;
    const value = data[fieldName];
    if (value === undefined) continue;
    const submittedValues =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? value
          : undefined;
    if (!submittedValues || submittedValues.length === 0) {
      return {
        statusCode: 400,
        error: 'invalid_request',
        message: `Service data field ${fieldName} must contain one or more entity_id values.`,
      };
    }
    if (!fieldPolicy.multiple && submittedValues.length !== 1) {
      return {
        statusCode: 400,
        error: 'invalid_request',
        message: `Service data field ${fieldName} accepts one entity_id value.`,
      };
    }
    const allowedDomains =
      fieldPolicy.allowedDomains.size > 0 ? fieldPolicy.allowedDomains : config.allowedDomains;
    const resolved = await resolveServiceEntityTargets(
      client,
      config,
      allowedDomains,
      submittedValues,
    );
    if ('error' in resolved) return resolved;
    if (typeof value === 'string') {
      if (resolved.entityIds.length !== 1) {
        return {
          statusCode: 400,
          error: 'invalid_request',
          message: `Service data field ${fieldName} cannot expand one entity_id into multiple targets.`,
        };
      }
      data[fieldName] = resolved.entityIds[0];
    } else {
      data[fieldName] = resolved.entityIds;
    }
  }

  const resolvedTargets = await resolveServiceEntityTargets(
    client,
    config,
    targetPolicy.targetDomains,
    entityIds,
  );
  if ('error' in resolvedTargets) {
    const targetFailure: TargetResolutionFailure = resolvedTargets;
    return targetFailure;
  }

  return {
    call: {
      domain: input.domain,
      service: input.service,
      entity_id:
        typeof input.entity_id === 'string' && resolvedTargets.entityIds.length === 1
          ? (resolvedTargets.entityIds[0] ?? resolvedTargets.entityIds)
          : resolvedTargets.entityIds,
      data,
      // Home Assistant rejects response-only services without this flag. Do
      // not request it for optional/non-response services: HA rejects that as
      // well when a service does not support responses.
      returnResponse: definition.response?.optional === false,
    },
  };
}

function sendPreparedCallError(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  result: Awaited<ReturnType<typeof prepareServiceCall>> | ReturnType<typeof prepareAdminAction>,
) {
  return reply.code(result.statusCode ?? 400).send({
    error: result.error ?? 'invalid_request',
    message: result.message ?? 'Invalid service call.',
  });
}

export async function registerServiceRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: HomeAssistantClient,
): Promise<void> {
  const rateLimitServiceCall = createServiceRateLimitHook(config);
  const dispatches = new Map<string, ServiceDispatch>();
  const dispatchOwners = new Map<string, string>();
  let activeDispatches = 0;

  const pruneDispatches = () => {
    const expiresBefore = Date.now() - 3_600_000;
    for (const [id, dispatch] of dispatches) {
      if (dispatch.completedAt && Date.parse(dispatch.completedAt) < expiresBefore) {
        dispatches.delete(id);
        dispatchOwners.delete(id);
      }
    }
    while (dispatches.size >= 100) {
      const completed = [...dispatches.values()].find((dispatch) => Boolean(dispatch.completedAt));
      if (!completed) break;
      dispatches.delete(completed.id);
      dispatchOwners.delete(completed.id);
    }
  };

  const dispatchServiceCall = (
    call: PreparedServiceCall,
    owner: string,
  ): ServiceDispatch | undefined => {
    pruneDispatches();
    if (activeDispatches >= config.asyncServiceMaxConcurrent) return undefined;

    const dispatch: ServiceDispatch = {
      id: randomUUID(),
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    dispatches.set(dispatch.id, dispatch);
    dispatchOwners.set(dispatch.id, owner);
    activeDispatches += 1;
    void client
      .callService(call, config.homeAssistantAsyncServiceTimeoutMs)
      .then(() => {
        dispatch.status = 'completed';
        dispatch.completedAt = new Date().toISOString();
      })
      .catch(() => {
        dispatch.status = 'failed';
        dispatch.completedAt = new Date().toISOString();
        dispatch.error = 'home_assistant_error';
        app.log.warn(
          { dispatchId: dispatch.id, domain: call.domain, service: call.service },
          'Asynchronous Home Assistant service call failed',
        );
      })
      .finally(() => {
        activeDispatches -= 1;
      });
    return dispatch;
  };

  registerGatewayAction(app, 'POST', '/api/v1/services/call', async (request, reply) => {
    if (!hasGatewayScope(request, 'write')) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'This gateway API key does not have write scope.',
      });
    }
    await rateLimitServiceCall(request, reply);
    if (reply.sent) return;

    if (config.readOnly) {
      return reply.code(403).send({
        error: 'read_only',
        message: 'Service calls are disabled because READ_ONLY=true.',
      });
    }

    const bodyResult = serviceCallSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send(invalidRequest(bodyResult.error.issues));
    }

    const basicValidation = validateBasicServiceInput(bodyResult.data, config);
    if (basicValidation.statusCode) return sendPreparedCallError(reply, basicValidation);

    const services = await client.getServices();
    const prepared = await prepareServiceCall(bodyResult.data, config, client, services);
    if (!prepared.call) return sendPreparedCallError(reply, prepared);

    if (
      config.asyncServiceDispatchEnabled &&
      config.asyncServiceDomains.has(prepared.call.domain)
    ) {
      const dispatch = dispatchServiceCall(
        prepared.call,
        request.gatewayAuth?.credentialIds.join(',') ?? '',
      );
      if (!dispatch) {
        return reply.code(429).send({
          error: 'rate_limited',
          message: 'Too many asynchronous service calls are already running.',
        });
      }
      return reply.code(202).send({ ok: true, accepted: true, dispatch });
    }

    const result = await client.callService(prepared.call);
    return { ok: true, result };
  });

  registerGatewayAction(app, 'POST', '/api/v1/services/batch', async (request, reply) => {
    if (!hasGatewayScope(request, 'write')) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'This gateway API key does not have write scope.',
      });
    }
    await rateLimitServiceCall(request, reply);
    if (reply.sent) return;

    if (config.readOnly) {
      return reply.code(403).send({
        error: 'read_only',
        message: 'Service calls are disabled because READ_ONLY=true.',
      });
    }

    const bodyResult = serviceBatchSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send(invalidRequest(bodyResult.error.issues));
    }

    // Validate the complete batch before any Home Assistant state can change.
    for (const input of bodyResult.data.calls) {
      const basicValidation = validateBasicServiceInput(input, config);
      if (basicValidation.statusCode) return sendPreparedCallError(reply, basicValidation);
    }

    const services = await client.getServices();
    const calls: PreparedServiceCall[] = [];
    for (const input of bodyResult.data.calls) {
      const prepared = await prepareServiceCall(input, config, client, services);
      if (!prepared.call) return sendPreparedCallError(reply, prepared);
      calls.push(prepared.call);
    }

    if (
      config.asyncServiceDispatchEnabled &&
      calls.some((call) => config.asyncServiceDomains.has(call.domain))
    ) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Asynchronous service domains must be called individually, not in a batch.',
      });
    }

    const results: unknown[] = [];
    for (const call of calls) {
      // This is deliberately sequential and stops on an upstream error. Home
      // Assistant has no generic transaction/rollback facility for services.
      results.push(await client.callService(call));
    }

    return { ok: true, results };
  });

  registerGatewayAction(
    app,
    'GET',
    '/api/v1/service-dispatches/:dispatchId',
    async (request, reply) => {
      if (!hasGatewayScope(request, 'write')) {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'This gateway API key does not have write scope.',
        });
      }
      const dispatchId = (request.params as { dispatchId?: string }).dispatchId;
      const dispatch = dispatchId ? dispatches.get(dispatchId) : undefined;
      if (
        !dispatch ||
        dispatchOwners.get(dispatch.id) !== request.gatewayAuth?.credentialIds.join(',')
      ) {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'Service dispatch was not found.' });
      }
      return { dispatch };
    },
  );

  registerGatewayAction(app, 'POST', '/api/v1/admin/actions/call', async (request, reply) => {
    if (!hasGatewayScope(request, 'write')) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'This gateway API key does not have write scope.',
      });
    }
    await rateLimitServiceCall(request, reply);
    if (reply.sent) return;
    if (config.readOnly) {
      return reply.code(403).send({
        error: 'read_only',
        message: 'Service calls are disabled because READ_ONLY=true.',
      });
    }

    const bodyResult = adminActionCallSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send(invalidRequest(bodyResult.error.issues));
    }
    if (!isAdminActionAllowed(config, bodyResult.data.domain, bodyResult.data.service)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'This Home Assistant administration action is not enabled.',
      });
    }
    const services = await client.getServices();
    const prepared = prepareAdminAction(bodyResult.data, config, client, services);
    if (!prepared.call) return sendPreparedCallError(reply, prepared);

    const result = await client.callService(prepared.call);
    return { ok: true, result };
  });
}
