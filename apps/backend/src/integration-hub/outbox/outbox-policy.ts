// Retry policy for outbound partner calls (docs/AGGREGATORS.md 4.3). Same
// schedule as outgoing webhooks: 1m, 5m, 30m, 2h, 12h, then dead-letter.
import { BACKOFF_MS, MAX_ATTEMPTS } from '../../modules/webhooks/signing';
import { OutboundError } from '../providers/provider';

export const ORDER_STATUS_KIND = 'order.status';

export const orderStatusDedupeKey = (externalOrderId: string, status: string) =>
  `${ORDER_STATUS_KIND}:${externalOrderId}:${status}`;

export function toOutboundError(err: unknown): OutboundError {
  if (err instanceof OutboundError) return err;
  return new OutboundError(
    err instanceof Error ? err.message : String(err),
    true,
  );
}

/** What a row becomes after its `attempts`-th attempt failed with `err`. */
export function afterFailure(
  attempts: number,
  err: OutboundError,
  now = new Date(),
): { status: 'PENDING' | 'DEAD'; nextAttemptAt: Date } {
  const dead = !err.retryable || attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!;
  return {
    status: dead ? 'DEAD' : 'PENDING',
    nextAttemptAt: new Date(now.getTime() + wait),
  };
}
