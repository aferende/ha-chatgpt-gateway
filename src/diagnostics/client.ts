import { z } from 'zod';
import type { GatewayConfig } from '../config/env.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const diagnosticsResponseSchema = z.object({
  source: z.literal('home_assistant_core'),
  requested_lines: z.number().int().min(1).max(500),
  returned_lines: z.number().int().min(0).max(500),
  truncated: z.boolean(),
  entries: z.array(z.string().max(24_576)).max(500),
});

export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

export class DiagnosticsAddonError extends Error {
  constructor(readonly kind: 'unavailable' | 'unexpected') {
    super('Diagnostics companion request failed');
    this.name = 'DiagnosticsAddonError';
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new DiagnosticsAddonError('unexpected');
  }

  if (!response.body) {
    throw new DiagnosticsAddonError('unexpected');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DiagnosticsAddonError('unexpected');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DiagnosticsAddonError('unexpected');
  }
}

export class DiagnosticsAddonClient {
  constructor(
    private readonly config: GatewayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getErrorLogs(lines: number): Promise<DiagnosticsResponse> {
    if (!this.config.diagnosticsAddonUrl || !this.config.diagnosticsAddonToken) {
      throw new DiagnosticsAddonError('unavailable');
    }

    const url = new URL('/api/v1/logs/errors', `${this.config.diagnosticsAddonUrl}/`);
    url.searchParams.set('lines', String(lines));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.config.diagnosticsAddonToken}` },
        signal: AbortSignal.timeout(Math.min(this.config.homeAssistantTimeoutMs, 30_000)),
      });
    } catch {
      throw new DiagnosticsAddonError('unavailable');
    }

    if (!response.ok) {
      throw new DiagnosticsAddonError(response.status >= 500 ? 'unavailable' : 'unexpected');
    }

    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof DiagnosticsAddonError) throw error;
      throw new DiagnosticsAddonError('unavailable');
    }

    const parsed = diagnosticsResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.requested_lines !== lines ||
      parsed.data.returned_lines !== parsed.data.entries.length ||
      parsed.data.entries.length > lines
    ) {
      throw new DiagnosticsAddonError('unexpected');
    }
    return parsed.data;
  }
}
