import type { GmailSendOutcome } from './gmail-smtp.js';

export const OUTBOX_DAILY_LIMIT = 100;
const backoffSeconds = [60, 300] as const;
export const OUTBOX_ATTEMPT_LIMIT = backoffSeconds.length + 1;

type DeliveryDecision = { state: 'queued'; retryAfterSeconds: number } | { state: 'sent' | 'failed' | 'held' };

export function resolveOutboxDelivery(outcome: GmailSendOutcome, attempt: number, messageId: string): DeliveryDecision {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > OUTBOX_ATTEMPT_LIMIT) return { state: 'held' };
  if (outcome.status === 'sent') return { state: outcome.messageId === messageId ? 'sent' : 'held' };
  if (outcome.status === 'invalid') return { state: 'failed' };
  if (outcome.status === 'rejected') {
    const { responseCode, retryable } = outcome;
    if (!Number.isInteger(responseCode) || responseCode < 400 || responseCode > 599 ||
        retryable !== (responseCode < 500)) return { state: 'held' };
    const delay = backoffSeconds[attempt - 1];
    return retryable && delay ? { state: 'queued', retryAfterSeconds: delay } : { state: 'failed' };
  }
  return { state: 'held' };
}