import type { FastifyInstance, FastifyRequest, FastifyReply, RouteHandlerMethod } from 'fastify';

export type GatewayAction = {
  method: 'GET' | 'POST';
  path: string;
  handler: RouteHandlerMethod;
  app: FastifyInstance;
};

declare module 'fastify' {
  interface FastifyInstance {
    gatewayActions: Map<string, GatewayAction>;
    gatewayLegacyRestEnabled: boolean;
  }
}

/** Register the same action handler for REST and in-process MCP execution. */
export function registerGatewayAction(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  path: string,
  handler: RouteHandlerMethod,
): void {
  if (app.hasDecorator('gatewayActions'))
    app.gatewayActions.set(`${method} ${path}`, { method, path, handler, app });
  if (
    path === '/health' ||
    !app.hasDecorator('gatewayLegacyRestEnabled') ||
    app.gatewayLegacyRestEnabled
  ) {
    app.route({ method, url: path, handler });
  }
}

export async function executeGatewayAction(
  action: GatewayAction,
  request: FastifyRequest,
  input: { params: Record<string, unknown>; query: Record<string, unknown>; body?: unknown },
): Promise<{ status: number; payload: unknown }> {
  // Preserve authenticated identity, resolved IP and audit context. No internal
  // HTTP request, copied API key, or second authentication/rate-limit pipeline.
  const actionRequest = Object.assign(Object.create(request) as FastifyRequest, input);
  let status = 200;
  let payload: unknown;
  let sent = false;
  const actionReply = {
    get sent() {
      return sent;
    },
    get statusCode() {
      return status;
    },
    code(value: number) {
      status = value;
      return this;
    },
    header() {
      return this;
    },
    send(value: unknown) {
      sent = true;
      payload = value;
      return this;
    },
  };
  const returned = await action.handler.call(
    action.app,
    actionRequest,
    actionReply as unknown as FastifyReply,
  );
  return { status, payload: sent ? payload : returned };
}
