import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../../audit/audit.js';
import { abortableInbox } from './gmail-imap.js';
import { checkInboundMailBudget, suppressedInboundMail } from './inbound-policy.js';
import { acquireMailbox, commitMailbox, releaseMailbox, type MailboxLease } from './mailbox-lease.js';
import { selectedInboxHeaders } from './selected-headers.js';
import { normalizeThreadIdentity } from './thread-identity.js';

const uint = z.number().int().min(0).max(0xffff_ffff);
const epoch = z.string().regex(/^[1-9][0-9]{0,9}$/).refine((v) => Number(v) <= 0xffff_ffff);
const result = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('accept'), reason: z.enum(['accepted','attachments-omitted']),
    omittedAttachments: z.number().int().min(0).max(32) }).refine((r) =>
      r.reason === (r.omittedAttachments ? 'attachments-omitted' : 'accepted')),
  z.object({ disposition: z.literal('skip'), reason: z.enum(['provider-spam','self-mail','delivery-report','auto-submitted','mailing-list']) }),
  z.object({ disposition: z.literal('quarantine'), reason: z.enum(['missing-metadata','missing-plaintext','ambiguous-plaintext',
    'invalid-text','invalid-headers','invalid-measurement','budget-exceeded']) }),
]);
const messageSchema = z.object({ uid: uint.min(1), providerId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/), result,
  text: z.string().optional(), headers: z.instanceof(Buffer).optional(), envelope: z.object({
    subject: z.string().optional(), messageId: z.string().optional(), inReplyTo: z.string().optional(),
    from: z.array(z.object({ address: z.string().optional() })).optional(),
  }).optional() });
const batchSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('resync'), uidValidity: epoch }),
  z.strictObject({ status: z.literal('batch'), uidValidity: epoch, throughUid: uint,
    messages: z.array(messageSchema).max(8) }),
]);
type Message = z.infer<typeof messageSchema>;
type Source = { mailbox: string; poll(cursor: { afterUid: number; uidValidity?: string }, signal: AbortSignal): Promise<unknown> };
// Supplied only by a trusted service that already authenticated and recognizes this participant.
// The lookup key is a provider identity. It receives no mail headers or claimed sender.
type VerifiedSender = (key: Readonly<{ mailbox: string; providerId: string }>) => string | null;
function canonicalSender(value?: string | null) {
  if (!value || value.length > 254 || !z.email().safeParse(value).success) return null;
  const at = value.lastIndexOf('@');
  return value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
}

function prepare(mailbox: string, msg: Message, verify?: VerifiedSender) {
  if (msg.result.disposition !== 'accept') return msg.result;
  const hints = selectedInboxHeaders(msg.headers);
  if (!hints) return { disposition: 'quarantine', reason: 'invalid-headers' } as const;
  const evidence = canonicalSender(verify?.({ mailbox, providerId: msg.providerId }));
  const from = msg.envelope?.from;
  const claimedSender = from?.length === 1 ? canonicalSender(from[0].address) : null;
  const sender = claimedSender === evidence ? evidence : null;
  const skip = suppressedInboundMail({ ...hints, knownSelfMail: sender === mailbox });
  if (skip) return skip;
  const text = msg.text ?? '';
  const over = checkInboundMailBudget('decodedTextBytes', Buffer.byteLength(text, 'utf8'));
  if (over) return over;
  if (text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) return { disposition: 'quarantine', reason: 'invalid-text' } as const;
  const subject = (msg.envelope?.subject ?? '').slice(0,240).replace(/\p{Cc}/gu,' ').replace(/[\uD800-\uDFFF]/gu,'�').trim() || 'Inbound email';
  return { ...msg.result, subject, text: text.trim() ? text : '[No plain-text content]', claimedSender, sender,
    ...normalizeThreadIdentity({ ...msg.envelope, references: hints.references }) };
}
type Prepared = ReturnType<typeof prepare>;

async function appendInbound(tx: Prisma.TransactionClient, mailbox: string, mail: Extract<Prepared, { disposition: 'accept' }>) {
  const parents = mail.sender && mail.candidates.length ? await tx.$queryRaw<{ ticket_id: string }[]>`
    SELECT DISTINCT m.ticket_id FROM control.inbound_receipt r JOIN control.ticket_message m ON m.id = r.message_row_id
    WHERE r.mailbox = ${mailbox} AND r.verified_sender = ${mail.sender} AND r.claimed_sender = r.verified_sender
      AND r.rfc_message_id = ANY(${mail.candidates}::text[])
    LIMIT 2` : [];
  const matched = parents.length === 1;
  const ticketId = matched ? parents[0].ticket_id : randomUUID();
  if (!matched) await tx.$executeRaw`INSERT INTO control.ticket(id,subject) VALUES (${ticketId}::uuid,${mail.subject})`;
  const [ticket] = await tx.$queryRaw<{ business_id: string | null }[]>`SELECT business_id FROM control.ticket
    WHERE id = ${ticketId}::uuid FOR UPDATE`;
  const id = randomUUID();
  await tx.$executeRaw`INSERT INTO control.ticket_message(id,ticket_id,sequence,direction,visibility,text)
    SELECT ${id}::uuid,${ticketId}::uuid,COALESCE(MAX(sequence),0)+1,'inbound','public',${mail.text}
    FROM control.ticket_message WHERE ticket_id = ${ticketId}::uuid`;
  await tx.$executeRaw`UPDATE control.ticket SET updated_at = greatest(updated_at,clock_timestamp()) WHERE id = ${ticketId}::uuid`;
  return {
    audit: { subjectId: ticketId, businessId: ticket.business_id },
    receipt: { messageRowId: id, rfcMessageId: mail.messageId, claimedSender: mail.claimedSender,
      verifiedSender: mail.sender, omittedAttachments: mail.omittedAttachments, reason: matched ? 'threaded' : 'triage' },
  };
}

async function persist(tx: Prisma.TransactionClient, mailbox: string, uidValidity: bigint,
  uid: number, providerId: string, mail: Prepared) {
  const key = { mailbox, uidValidity, uid: BigInt(uid) };
  const delivery = await tx.mailboxDelivery.findUnique({ where: { mailbox_uidValidity_uid: key } });
  if (delivery) {
    if (delivery.providerId !== providerId) throw new Error('Inconsistent delivery');
    return;
  }
  const previous = await tx.inboundReceipt.findUnique({ where: { mailbox_providerId: { mailbox, providerId } }, select: { providerId: true } });
  let audit: { subjectId: string; businessId: string | null } | undefined;
  if (!previous) {
    const accepted = mail.disposition === 'accept' ? await appendInbound(tx, mailbox, mail) : undefined;
    audit = accepted?.audit;
    await tx.inboundReceipt.create({ data: { mailbox, providerId, outcome: mail.disposition, reason: mail.reason, ...accepted?.receipt }, select: { providerId: true } });
  }
  await tx.mailboxDelivery.create({ data: { ...key, providerId } });
  return audit;
}

/** One bounded poll. A Gmail IMAP transport supplies no verified sender evidence. */
export async function pollInbox(db: PrismaClient, source: Source, cancel: AbortSignal, verify?: VerifiedSender) {
  let lease: MailboxLease | null = null;
  try {
    const mailbox = source.mailbox;
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(35_000)]);
    signal.throwIfAborted();
    lease = await acquireMailbox(db, mailbox);
    if (!lease) return 'busy';
    const cursor = { uidValidity: lease.uidValidity, afterUid: lease.afterUid };
    const raw = await abortableInbox(signal, () => source.poll(cursor, signal));
    if (raw && typeof raw === 'object' && 'messages' in raw && Array.isArray(raw.messages) && raw.messages.length > 8) {
      throw new Error('Oversized inbox window');
    }
    const batch = batchSchema.parse(raw);
    const rows = batch.status === 'batch' ? batch.messages : [];
    const throughUid = batch.status === 'batch' ? batch.throughUid : 0;
    let last = lease.afterUid;
    const prepared = rows.map((msg) => {
      if (msg.uid <= last || msg.uid > throughUid) throw new Error('Inconsistent inbox window');
      last = msg.uid;
      return { uid: msg.uid, providerId: msg.providerId, mail: prepare(mailbox, msg, verify) };
    });
    await commitMailbox(db, lease, { status: batch.status, uidValidity: batch.uidValidity, throughUid }, async (tx) => {
      const audits = [];
      for (const row of prepared) {
        signal.throwIfAborted();
        const audit = await persist(tx, mailbox, BigInt(batch.uidValidity), row.uid, row.providerId, row.mail);
        if (audit) audits.push(audit);
      }
      // Acquire the global audit lock only after all ticket rows in this batch are locked.
      for (const audit of audits) {
        await appendAuditEvent(tx, { ...audit, actorType: 'service', actorId: '00000000-0000-4000-8000-000000000274',
          action: 'ticket.inbound', subjectType: 'ticket', requestId: randomUUID(), outcome: 'succeeded' });
      }
      signal.throwIfAborted();
    });
    return batch.status;
  } catch {
    if (lease) await releaseMailbox(db, lease).catch(() => undefined);
    throw new Error('Inbox intake failed');
  }
}
