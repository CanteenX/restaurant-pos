import type { GmailSendOutcome } from './gmail-smtp.js';

const attemptLimit = 3;
type DeliveryDecision = { state: 'queued' | 'sent' | 'failed' | 'held' };

export function resolveOutboxDelivery(outcome: GmailSendOutcome, attempt: number, messageId: string): DeliveryDecision {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > attemptLimit) return { state: 'held' };
  if (outcome.status === 'sent') return { state: outcome.messageId === messageId ? 'sent' : 'held' };
  if (outcome.status === 'invalid') return { state: 'failed' };
  if (outcome.status === 'rejected') {
    const { responseCode, retryable } = outcome;
    if (!Number.isInteger(responseCode) || responseCode < 400 || responseCode > 599 ||
        retryable !== (responseCode < 500)) return { state: 'held' };
    return { state: retryable && attempt < attemptLimit ? 'queued' : 'failed' };
  }
  return { state: 'held' };
}
