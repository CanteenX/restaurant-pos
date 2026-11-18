import { createHmac } from 'node:crypto';

/** HMAC-SHA256 over `<timestamp>.<raw body>`, used in both directions. */
export function signAggregatorBody(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}
