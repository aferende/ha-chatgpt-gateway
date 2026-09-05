import proxyaddr from '@fastify/proxy-addr';
import { z } from 'zod';
import { supportedAdminActions } from '../security/admin-actions.js';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const gatewayKeySchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, 'Gateway API keys must be exactly 64 hexadecimal characters.');

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    HOME_ASSISTANT_URL: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value), 'HOME_ASSISTANT_URL must use HTTP or HTTPS'),
    HOME_ASSISTANT_TOKEN: z.string().min(1, 'HOME_ASSISTANT_TOKEN is required'),
    // Legacy full-access key. Prefer the scoped keys for a new deployment.
    GATEWAY_API_KEY: gatewayKeySchema.optional(),
    GATEWAY_READ_API_KEY: gatewayKeySchema.optional(),
    GATEWAY_WRITE_API_KEY: gatewayKeySchema.optional(),
    ALLOWED_DOMAINS: z.string().min(1, 'ALLOWED_DOMAINS is required'),
    ALLOWED_ENTITIES: z.string().default(''),
    READ_ONLY: booleanFromString,
    ENABLE_LOGBOOK: booleanFromString,
    ENABLE_ERROR_LOGS: booleanFromString,
    DIAGNOSTICS_ADDON_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .url()
        .refine(
          (value) => /^https?:\/\//i.test(value),
          'DIAGNOSTICS_ADDON_URL must use HTTP or HTTPS',
        )
        .optional(),
    ),
    DIAGNOSTICS_ADDON_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      gatewayKeySchema.optional(),
    ),
    LOG_LEVEL: logLevelSchema.default('info'),
    HOME_ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    HOME_ASSISTANT_SERVICE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(30_000),
    ENABLE_ASYNC_SERVICE_DISPATCH: booleanFromString,
    ASYNC_SERVICE_DOMAINS: z.string().default(''),
    HOME_ASSISTANT_ASYNC_SERVICE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(1_800_000),
    ASYNC_SERVICE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(10).default(2),
    ENABLE_ADMIN_ACTIONS: booleanFromString,
    ADMIN_ALLOWED_ACTIONS: z.string().default(''),
    RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000).default(120),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    SERVICE_RATE_LIMIT_MAX: z.coerce.number().int().min(0).max(10_000).default(20),
    SERVICE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    TRUSTED_PROXIES: z.string().default(''),
    PUBLIC_BASE_URL: z.string().url().optional(),
  })
  .superRefine((value, context) => {
    if (!value.GATEWAY_API_KEY && !value.GATEWAY_READ_API_KEY && !value.GATEWAY_WRITE_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_API_KEY'],
        message:
          'Set GATEWAY_API_KEY or at least one of GATEWAY_READ_API_KEY and GATEWAY_WRITE_API_KEY.',
      });
    }

    const configuredKeys = [
      value.GATEWAY_API_KEY,
      value.GATEWAY_READ_API_KEY,
      value.GATEWAY_WRITE_API_KEY,
    ].filter((key): key is string => Boolean(key));
    if (new Set(configuredKeys).size !== configuredKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['GATEWAY_READ_API_KEY'],
        message: 'Configured gateway API keys must be distinct.',
      });
    }

    if (!value.READ_ONLY && parseCsv(value.ALLOWED_ENTITIES).size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOWED_ENTITIES'],
        message: 'READ_ONLY=false requires a non-empty ALLOWED_ENTITIES allow-list.',
      });
    }

    if (value.ENABLE_ERROR_LOGS) {
      if (!value.DIAGNOSTICS_ADDON_URL) {
        context.addIssue({
          code: 'custom',
          path: ['DIAGNOSTICS_ADDON_URL'],
          message: 'ENABLE_ERROR_LOGS=true requires DIAGNOSTICS_ADDON_URL.',
        });
      }
      if (!value.DIAGNOSTICS_ADDON_TOKEN) {
        context.addIssue({
          code: 'custom',
          path: ['DIAGNOSTICS_ADDON_TOKEN'],
          message: 'ENABLE_ERROR_LOGS=true requires DIAGNOSTICS_ADDON_TOKEN.',
        });
      }
    }

    const asyncServiceDomains = parseCsv(value.ASYNC_SERVICE_DOMAINS);
    if (value.ENABLE_ASYNC_SERVICE_DISPATCH && asyncServiceDomains.size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['ASYNC_SERVICE_DOMAINS'],
        message: 'ENABLE_ASYNC_SERVICE_DISPATCH=true requires ASYNC_SERVICE_DOMAINS.',
      });
    }
    if (!value.ENABLE_ASYNC_SERVICE_DISPATCH && asyncServiceDomains.size > 0) {
      context.addIssue({
        code: 'custom',
        path: ['ASYNC_SERVICE_DOMAINS'],
        message: 'ASYNC_SERVICE_DOMAINS requires ENABLE_ASYNC_SERVICE_DISPATCH=true.',
      });
    }
    for (const domain of asyncServiceDomains) {
      if (!parseCsv(value.ALLOWED_DOMAINS).has(domain)) {
        context.addIssue({
          code: 'custom',
          path: ['ASYNC_SERVICE_DOMAINS'],
          message: 'Every ASYNC_SERVICE_DOMAINS entry must also be in ALLOWED_DOMAINS.',
        });
        break;
      }
    }

    const adminAllowedActions = parseCsv(value.ADMIN_ALLOWED_ACTIONS);
    if (value.ENABLE_ADMIN_ACTIONS && adminAllowedActions.size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['ADMIN_ALLOWED_ACTIONS'],
        message: 'ENABLE_ADMIN_ACTIONS=true requires ADMIN_ALLOWED_ACTIONS.',
      });
    }
    if (!value.ENABLE_ADMIN_ACTIONS && adminAllowedActions.size > 0) {
      context.addIssue({
        code: 'custom',
        path: ['ADMIN_ALLOWED_ACTIONS'],
        message: 'ADMIN_ALLOWED_ACTIONS requires ENABLE_ADMIN_ACTIONS=true.',
      });
    }
    for (const action of adminAllowedActions) {
      if (!supportedAdminActions.has(action)) {
        context.addIssue({
          code: 'custom',
          path: ['ADMIN_ALLOWED_ACTIONS'],
          message: 'ADMIN_ALLOWED_ACTIONS contains an unsupported global action.',
        });
        break;
      }
    }

    try {
      proxyaddr.compile([...parseCsv(value.TRUSTED_PROXIES)]);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXIES'],
        message: 'TRUSTED_PROXIES must contain only valid IP addresses or CIDR ranges.',
      });
    }
  });

export type GatewayScope = 'read' | 'write';

export interface GatewayCredential {
  id: 'legacy' | 'read' | 'write';
  key: string;
  scopes: ReadonlySet<GatewayScope>;
}

export interface GatewayConfig {
  port: number;
  homeAssistantUrl: string;
  homeAssistantToken: string;
  /** @deprecated Prefer gatewayCredentials for authentication decisions. */
  gatewayApiKey: string;
  gatewayCredentials: readonly GatewayCredential[];
  allowedDomains: ReadonlySet<string>;
  allowedEntities: ReadonlySet<string>;
  readOnly: boolean;
  logbookEnabled: boolean;
  errorLogsEnabled: boolean;
  diagnosticsAddonUrl?: string;
  diagnosticsAddonToken?: string;
  logLevel: z.infer<typeof logLevelSchema>;
  homeAssistantTimeoutMs: number;
  homeAssistantServiceTimeoutMs: number;
  asyncServiceDispatchEnabled: boolean;
  asyncServiceDomains: ReadonlySet<string>;
  homeAssistantAsyncServiceTimeoutMs: number;
  asyncServiceMaxConcurrent: number;
  adminActionsEnabled: boolean;
  adminAllowedActions: ReadonlySet<string>;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  serviceRateLimitMax: number;
  serviceRateLimitWindowMs: number;
  /** Explicit reverse-proxy peers trusted to supply forwarding headers. */
  trustedProxies: readonly string[];
  publicBaseUrl?: string;
}

function parseCsv(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(env);
  const allowedDomains = parseCsv(parsed.ALLOWED_DOMAINS);

  if (allowedDomains.size === 0) {
    throw new Error('ALLOWED_DOMAINS must contain at least one domain');
  }

  const credentialScopes = new Map<string, Set<GatewayScope>>();
  const addCredential = (key: string | undefined, scope: GatewayScope | 'legacy') => {
    if (!key) return;
    const scopes = credentialScopes.get(key) ?? new Set<GatewayScope>();
    scopes.add('read');
    if (scope === 'write' || scope === 'legacy') scopes.add('write');
    credentialScopes.set(key, scopes);
  };
  addCredential(parsed.GATEWAY_API_KEY, 'legacy');
  addCredential(parsed.GATEWAY_READ_API_KEY, 'read');
  addCredential(parsed.GATEWAY_WRITE_API_KEY, 'write');

  const gatewayCredentials = [...credentialScopes.entries()].map(([key, scopes]) => ({
    id: scopes.has('write') ? ('write' as const) : ('read' as const),
    key,
    scopes,
  }));

  return {
    port: parsed.PORT,
    homeAssistantUrl: parsed.HOME_ASSISTANT_URL.replace(/\/$/, ''),
    homeAssistantToken: parsed.HOME_ASSISTANT_TOKEN,
    gatewayApiKey:
      parsed.GATEWAY_API_KEY ?? parsed.GATEWAY_WRITE_API_KEY ?? parsed.GATEWAY_READ_API_KEY ?? '',
    gatewayCredentials,
    allowedDomains,
    allowedEntities: parseCsv(parsed.ALLOWED_ENTITIES),
    readOnly: parsed.READ_ONLY,
    logbookEnabled: parsed.ENABLE_LOGBOOK,
    errorLogsEnabled: parsed.ENABLE_ERROR_LOGS,
    diagnosticsAddonUrl: parsed.DIAGNOSTICS_ADDON_URL?.replace(/\/$/, ''),
    diagnosticsAddonToken: parsed.DIAGNOSTICS_ADDON_TOKEN,
    logLevel: parsed.LOG_LEVEL,
    homeAssistantTimeoutMs: parsed.HOME_ASSISTANT_TIMEOUT_MS,
    homeAssistantServiceTimeoutMs: parsed.HOME_ASSISTANT_SERVICE_TIMEOUT_MS,
    asyncServiceDispatchEnabled: parsed.ENABLE_ASYNC_SERVICE_DISPATCH,
    asyncServiceDomains: parseCsv(parsed.ASYNC_SERVICE_DOMAINS),
    homeAssistantAsyncServiceTimeoutMs: parsed.HOME_ASSISTANT_ASYNC_SERVICE_TIMEOUT_MS,
    asyncServiceMaxConcurrent: parsed.ASYNC_SERVICE_MAX_CONCURRENT,
    adminActionsEnabled: parsed.ENABLE_ADMIN_ACTIONS,
    adminAllowedActions: parseCsv(parsed.ADMIN_ALLOWED_ACTIONS),
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    serviceRateLimitMax: parsed.SERVICE_RATE_LIMIT_MAX,
    serviceRateLimitWindowMs: parsed.SERVICE_RATE_LIMIT_WINDOW_MS,
    trustedProxies: [...parseCsv(parsed.TRUSTED_PROXIES)],
    publicBaseUrl: parsed.PUBLIC_BASE_URL?.replace(/\/$/, ''),
  };
}
