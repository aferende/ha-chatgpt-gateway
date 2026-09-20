import { z } from 'zod';

// A literal "+" in a query string is decoded as a space before route validation.
// Repair only the complete ISO-8601 shape that can result from that single decoding step.
const RAW_PLUS_OFFSET_DATE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?) (\d{2}:\d{2})$/;

export function normalizeIsoDateTimeQueryValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(RAW_PLUS_OFFSET_DATE_TIME, '$1+$2');
}

export const isoDateTimeQuerySchema = z.preprocess(
  normalizeIsoDateTimeQueryValue,
  z.string().datetime({ offset: true }),
);
