import { registerGatewayAction } from '../http/actions.js';
import type { FastifyInstance } from 'fastify';
import type { GatewayConfig } from '../config/env.js';
import { APP_VERSION } from '../version.js';

export async function registerHealthRoute(
  app: FastifyInstance,
  config: GatewayConfig,
): Promise<void> {
  registerGatewayAction(app, 'GET', '/health', async () => ({
    status: 'ok',
    version: APP_VERSION,
    readOnly: config.readOnly,
  }));
}
