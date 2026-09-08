import { describe, expect, it } from 'vitest';
import { redactSensitive, redactSensitiveText } from './redaction.js';

describe('redaction', () => {
  it('redacts sensitive object keys recursively', () => {
    expect(
      redactSensitive({
        name: 'safe',
        nested: {
          access_token: 'abc123',
          password: 'secret-value',
        },
      }),
    ).toEqual({
      name: 'safe',
      nested: {
        access_token: '[REDACTED]',
        password: '[REDACTED]',
      },
    });
  });

  it('redacts common credentials embedded in text', () => {
    const input = 'Authorization: Bearer abc.def.ghi password=hunter2 "api_key":"super-secret"';
    const output = redactSensitiveText(input);

    expect(output).not.toContain('abc.def.ghi');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('super-secret');
    expect(output).toContain('[REDACTED]');
  });

  it('leaves ordinary diagnostic text intact', () => {
    expect(redactSensitiveText('2026-09-02 ERROR zigbee connection timeout')).toBe(
      '2026-09-02 ERROR zigbee connection timeout',
    );
  });

  it('redacts credential URLs, webhook paths, and sensitive query parameters', () => {
    const input = 'ERROR https://user:pass@example.test/api/webhook/hook-secret?token=query-secret';
    const output = redactSensitiveText(input);

    expect(output).not.toContain('user:pass');
    expect(output).not.toContain('hook-secret');
    expect(output).not.toContain('query-secret');
  });
});
