import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/env.js';
import type { HomeAssistantClient } from '../home-assistant/client.js';
import { invalidRequest } from '../http/errors.js';
import { isoDateTimeQuerySchema } from '../schemas/iso-date-time.js';
import { isEntityAllowed } from '../security/authorization.js';
import { redactSensitive } from '../security/redaction.js';

const MAX_UNSCOPED_LOGBOOK_HOURS = 24;
const MAX_SCOPED_LOGBOOK_DAYS = 7;
const MAX_LOGBOOK_ENTRIES = 500;
const logbookQuerySchema = z.object({
  start_time: isoDateTimeQuerySchema,
  end_time: isoDateTimeQuerySchema.optional(),
  entity_id: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LOGBOOK_ENTRIES).default(200),
  include_state: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

function getLogbookEntityId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const entityId = (entry as Record<string, unknown>).entity_id;
  return typeof entityId === 'string' ? entityId : undefined;
}

export async function registerLogbookRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: HomeAssistantClient,
): Promise<void> {
  if (config.logbookEnabled) {
    app.get('/api/v1/logbook', async (request, reply) => {
      const queryResult = logbookQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.code(400).send(invalidRequest(queryResult.error.issues));
      }

      const startTime = new Date(queryResult.data.start_time);
      const endTime = new Date(queryResult.data.end_time ?? new Date().toISOString());
      const requestedEntityId = queryResult.data.entity_id;
      const maxRangeMs = requestedEntityId
        ? MAX_SCOPED_LOGBOOK_DAYS * 86_400_000
        : MAX_UNSCOPED_LOGBOOK_HOURS * 3_600_000;

      if (endTime <= startTime || endTime.getTime() - startTime.getTime() > maxRangeMs) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: requestedEntityId
            ? `Entity-scoped logbook ranges must be positive and no longer than ${MAX_SCOPED_LOGBOOK_DAYS} days.`
            : `Unscoped logbook ranges must be positive and no longer than ${MAX_UNSCOPED_LOGBOOK_HOURS} hours. Use entity_id for longer diagnostic windows.`,
        });
      }

      if (requestedEntityId && !isEntityAllowed(config, requestedEntityId)) {
        return reply.code(403).send({ error: 'forbidden', message: 'Entity is not allowed.' });
      }

      const raw = await client.getLogbook(
        startTime.toISOString(),
        endTime.toISOString(),
        requestedEntityId,
      );
      const entries = Array.isArray(raw) ? raw : [];
      const allowedEntries = entries.filter((entry) => {
        const entityId = getLogbookEntityId(entry);
        return entityId !== undefined && isEntityAllowed(config, entityId);
      });
      const limitedEntries = allowedEntries.slice(0, queryResult.data.limit);
      const minimizedEntries = queryResult.data.include_state
        ? limitedEntries
        : limitedEntries.map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
            const rest = { ...(entry as Record<string, unknown>) };
            delete rest.state;
            return rest;
          });

      return {
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
        entity_id: requestedEntityId ?? null,
        include_state: queryResult.data.include_state,
        total_allowed_entries: allowedEntries.length,
        returned_entries: limitedEntries.length,
        truncated: limitedEntries.length < allowedEntries.length,
        // Redaction is defense in depth; authorization, filtering, range bounds, and state minimization are primary.
        entries: redactSensitive(minimizedEntries),
      };
    });
  }
}
