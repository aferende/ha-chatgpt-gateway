import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config/env.js';
import { DiagnosticsAddonClient, DiagnosticsAddonError } from './diagnostics/client.js';
import {
  HomeAssistantClient,
  HomeAssistantError,
  type WebSocketFactory,
} from './home-assistant/client.js';
import { buildOpenApiSchema } from './openapi/action-schema.js';
import { registerEntityRoutes } from './routes/entities.js';
import { registerErrorLogRoutes } from './routes/error-logs.js';
import { registerHealthRoute } from './routes/health.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerLogbookRoutes } from './routes/logbook.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerSystemRoutes } from './routes/system.js';
import { createAuthenticationHook } from './security/authentication.js';
import { createRateLimitHook } from './security/rate-limit.js';

export interface BuildAppOptions {
  config: GatewayConfig;
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: options.config.logLevel },
    bodyLimit: 1024 * 1024,
    trustProxy:
      options.config.trustedProxies.length > 0 ? [...options.config.trustedProxies] : false,
  });

  const client = new HomeAssistantClient(
    options.config,
    options.fetchImpl,
    options.webSocketFactory,
  );
  const diagnosticsClient = new DiagnosticsAddonClient(options.config, options.fetchImpl);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DiagnosticsAddonError) {
      const statusCode = error.kind === 'unavailable' ? 503 : 502;
      return reply.code(statusCode).send({
        error: statusCode === 503 ? 'diagnostics_addon_unavailable' : 'diagnostics_addon_error',
        message:
          statusCode === 503
            ? 'The diagnostics companion is currently unavailable.'
            : 'The diagnostics companion returned an unexpected response.',
      });
    }

    if (error instanceof HomeAssistantError) {
      const statusCode = error.statusCode === 404 ? 404 : error.kind === 'http' ? 502 : 503;
      return reply.code(statusCode).send({
        error:
          statusCode === 503
            ? 'home_assistant_unavailable'
            : statusCode === 404
              ? 'not_found'
              : 'home_assistant_error',
        message:
          statusCode === 404
            ? 'The requested Home Assistant resource was not found.'
            : statusCode === 503
              ? 'Home Assistant is currently unavailable.'
              : 'Home Assistant returned an unexpected response.',
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: 'internal_error',
      message: 'An unexpected gateway error occurred.',
    });
  });

  await registerHealthRoute(app, options.config);

  app.get('/openapi.json', async () =>
    buildOpenApiSchema(options.config.publicBaseUrl, {
      logbookEnabled: options.config.logbookEnabled,
      errorLogsEnabled: options.config.errorLogsEnabled,
    }),
  );

  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', createRateLimitHook(options.config));
    protectedApp.addHook('onRequest', createAuthenticationHook(options.config));
    await registerEntityRoutes(protectedApp, options.config, client);
    await registerErrorLogRoutes(protectedApp, options.config, diagnosticsClient);
    await registerHistoryRoutes(protectedApp, options.config, client);
    await registerLogbookRoutes(protectedApp, options.config, client);
    await registerServiceRoutes(protectedApp, options.config, client);
    await registerSystemRoutes(protectedApp, options.config, client);
  });

  return app;
}
