import { z } from 'zod';

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, 'OAuth URLs must be HTTPS without credentials, query strings or fragments.');

const schema = z
  .object({
    MCP_PUBLIC_URL: httpsUrl,
    MCP_OAUTH_ISSUER: httpsUrl,
    MCP_OAUTH_JWKS_URL: httpsUrl.optional(),
    MCP_OAUTH_INTROSPECTION_URL: httpsUrl.optional(),
    MCP_OAUTH_CLIENT_ID: z.string().optional(),
    MCP_OAUTH_CLIENT_SECRET: z.string().optional(),
    MCP_OAUTH_REQUIRE_ROLES: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    MCP_SETUP_ONLY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((value, context) => {
    if (!value.MCP_SETUP_ONLY && !value.MCP_OAUTH_JWKS_URL && !value.MCP_OAUTH_INTROSPECTION_URL) {
      context.addIssue({
        code: 'custom',
        path: ['MCP_OAUTH_JWKS_URL'],
        message: 'A verified OAuth token validation method is required before enabling MCP tools.',
      });
    }
    if (value.MCP_OAUTH_JWKS_URL && value.MCP_OAUTH_INTROSPECTION_URL)
      context.addIssue({
        code: 'custom',
        path: ['MCP_OAUTH_JWKS_URL'],
        message: 'Choose exactly one OAuth verification method.',
      });
    if (
      value.MCP_OAUTH_INTROSPECTION_URL &&
      (!value.MCP_OAUTH_CLIENT_ID || !value.MCP_OAUTH_CLIENT_SECRET)
    )
      context.addIssue({
        code: 'custom',
        path: ['MCP_OAUTH_CLIENT_ID'],
        message: 'Authenticated introspection requires resource-server client credentials.',
      });
  });

export interface McpConfig {
  publicUrl: string;
  issuer: string;
  jwksUrl?: string;
  introspectionUrl?: string;
  clientId?: string;
  clientSecret?: string;
  requireRoles?: boolean;
  setupOnly: boolean;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig | undefined {
  if (env.ENABLE_MCP === undefined || env.ENABLE_MCP === 'false') return undefined;
  if (env.ENABLE_MCP !== 'true') throw new Error('ENABLE_MCP must be true or false.');
  const parsed = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  return {
    publicUrl: parsed.MCP_PUBLIC_URL,
    issuer: parsed.MCP_OAUTH_ISSUER,
    jwksUrl: parsed.MCP_OAUTH_JWKS_URL,
    introspectionUrl: parsed.MCP_OAUTH_INTROSPECTION_URL,
    clientId: parsed.MCP_OAUTH_CLIENT_ID,
    clientSecret: parsed.MCP_OAUTH_CLIENT_SECRET,
    requireRoles: parsed.MCP_OAUTH_REQUIRE_ROLES,
    setupOnly: parsed.MCP_SETUP_ONLY,
  };
}
