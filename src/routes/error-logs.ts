import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from '../config/env.js';
import type { DiagnosticsAddonClient } from '../diagnostics/client.js';
import { invalidRequest } from '../http/errors.js';
import { redactSensitiveText } from '../security/redaction.js';

const errorLogsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(500).default(100),
});

export async function registerErrorLogRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  client: DiagnosticsAddonClient,
): Promise<void> {
  if (!config.errorLogsEnabled) return;

  app.get('/api/v1/logs/errors', async (request, reply) => {
    const queryResult = errorLogsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send(invalidRequest(queryResult.error.issues));
    }

    reply.header('Cache-Control', 'no-store');
    const result = await client.getErrorLogs(queryResult.data.lines);
    const entries = result.entries.map(redactSensitiveText);
    return { ...result, returned_lines: entries.length, entries };
  });
}
