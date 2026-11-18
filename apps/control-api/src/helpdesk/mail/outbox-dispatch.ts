import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import type { GmailSendOutcome } from './gmail-smtp.js';

import { abortableInbox } from './gmail-imap.js';
import { resolveOutboxDelivery } from './outbox-policy.js';

type Claim = { row_id: string; token: string; attempt: number; recipient: string; message_id: string;
  subject: string; in_reply_to: string | null; rendered_text: string; rendered_html: string };
type Mail = { to: string; subject: string; messageId: string; inReplyTo?: string; text: string; html: string };
type Delivery = 'idle' | 'sent' | 'queued' | 'failed' | 'held';

export async function dispatchOutbox(db: PrismaClient, smtp: { send(message: Mail): Promise<GmailSendOutcome> }, signal: AbortSignal): Promise<Delivery> {
  if (signal.aborted) return 'idle';
  const [claim] = await db.$queryRaw<Claim[]>`SELECT * FROM control.claim_ticket_reply()`;
  if (!claim) return 'idle';
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
  let outcome: GmailSendOutcome;
  try {
    outcome = await abortableInbox(deadline, () => smtp.send({ to: claim.recipient, subject: claim.subject,
      messageId: claim.message_id, inReplyTo: claim.in_reply_to ?? undefined, text: claim.rendered_text, html: claim.rendered_html }));
  } catch {
    outcome = { status: 'ambiguous' };
  }
  const decision = resolveOutboxDelivery(outcome, claim.attempt, claim.message_id);
  const [finished] = await db.$queryRaw<{ state: Exclude<Delivery,'idle'> | null }[]>`
    SELECT control.finish_ticket_reply(${claim.row_id}::uuid,${claim.token}::uuid,${decision.state}) AS state`;
  return finished.state ?? 'held';
}
