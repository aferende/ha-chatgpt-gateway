import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import { invalidRequest } from '../http/errors.js';
import { entityParamsSchema } from '../schemas/entity.js';
import { isoDateTimeQuerySchema } from '../schemas/iso-date-time.js';
import { getEntityDomain, isEntityAllowed } from '../security/authorization.js';
import { redactSensitive } from '../security/redaction.js';

const MAX_HISTORY_DAYS = 31;

const historyQuerySchema = z.object({
  start_time: isoDateTimeQuerySchema,
  end_time: isoDateTimeQuerySchema.optional(),
  max_points: z.coerce.number().int().min(2).max(5_000).default(1_000),
});

function toHistoryPoint(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ['state', 'last_changed', 'last_updated', 'last_reported']) {
    if (typeof record[key] === 'string') {
      result[key] = record[key];
    }
  }
  return typeof result.state === 'string' ? result : undefined;
}

function samplePoints<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) {
    return points;
  }

  return Array.from({ length: maxPoints }, (_value, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    return points[sourceIndex] as T;
  });
}

export async function registerHistoryRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: HomeAssistantClient,
): Promise<void> {
  app.get('/api/v1/entities/:entityId/history', async (request, reply) => {
    const paramsResult = entityParamsSchema.safeParse(request.params);
    const queryResult = historyQuerySchema.safeParse(request.query);
    if (!paramsResult.success) {
      return reply.code(400).send(invalidRequest(paramsResult.error.issues));
    }
    if (!queryResult.success) {
      return reply.code(400).send(invalidRequest(queryResult.error.issues));
    }

    const { entityId } = paramsResult.data;
    if (!isEntityAllowed(config, entityId)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Entity is not allowed.' });
    }

    const startTime = new Date(queryResult.data.start_time);
    const endTime = new Date(queryResult.data.end_time ?? new Date().toISOString());
    if (
      endTime <= startTime ||
      endTime.getTime() - startTime.getTime() > MAX_HISTORY_DAYS * 86_400_000
    ) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: `History ranges must be positive and no longer than ${MAX_HISTORY_DAYS} days.`,
      });
    }

    const history = await client.getEntityHistory(
      entityId,
      startTime.toISOString(),
      endTime.toISOString(),
    );
    const firstSeries = Array.isArray(history) && Array.isArray(history[0]) ? history[0] : [];
    const points = firstSeries
      .map(toHistoryPoint)
      .filter((point): point is Record<string, string> => point !== undefined);
    const sampledPoints = samplePoints(points, queryResult.data.max_points);

    return {
      entity_id: entityId,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      total_points: points.length,
      returned_points: sampledPoints.length,
      sampled: sampledPoints.length < points.length,
      points: sampledPoints,
    };
  });

  app.get('/api/v1/automations/:entityId', async (request, reply) => {
    const paramsResult = entityParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send(invalidRequest(paramsResult.error.issues));
    }

    const { entityId } = paramsResult.data;
    if (getEntityDomain(entityId) !== 'automation' || !isEntityAllowed(config, entityId)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Entity is not allowed.' });
    }

    const state = await client.getState(entityId);
    const automationId = state.attributes.id;
    if (typeof automationId !== 'string' && typeof automationId !== 'number') {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Home Assistant did not expose an automation configuration ID.',
      });
    }

    return {
      entity_id: entityId,
      friendly_name:
        typeof state.attributes.friendly_name === 'string'
          ? state.attributes.friendly_name
          : entityId,
      state: state.state,
      automation: redactSensitive(await client.getAutomationConfig(String(automationId))),
    };
  });
}
