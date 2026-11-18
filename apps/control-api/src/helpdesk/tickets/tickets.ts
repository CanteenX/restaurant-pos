import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { controlPermissionSatisfied, type ticketListPage, type ticketMessagePage, type ticketNote, type ticketPatch } from '@nventra/types';
import type { z } from 'zod';
import type { ticketReply } from '@nventra/types/dist/control-reply';
import { renderTicketReply } from '@nventra/types/dist/node/email-renderer';
import { replyTarget } from './reply-target.js';
import type { Prisma } from '../../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../../audit/audit.js';
import type { StaffAccess } from '../../staff/staff-access.js';

const ticketFields = {
  id: true, subject: true, status: true, priority: true, businessId: true,
  outletId: true, ownerId: true, createdAt: true, updatedAt: true,
} as const;
const noteFields = {
  id: true, text: true, sequence: true, direction: true, visibility: true, authorId: true, createdAt: true,
} as const;

const messageFields = { ...noteFields, replyOutbox: { select: { state: true } } } as const;
type Message = Prisma.TicketMessageGetPayload<{ select: typeof messageFields }>;
type ReplyOrigin = { parentId: string; claimedSender: string | null; verifiedSender: string | null };

function messageWithState({ replyOutbox, ...message }: Message) {
  return replyOutbox ? { ...message, deliveryState: replyOutbox.state } : message;
}

async function firstAcceptedOrigin(tx: Prisma.TransactionClient, id: string): Promise<ReplyOrigin | null> {
  const [origin] = await tx.$queryRaw<ReplyOrigin[]>`
    SELECT m.id AS "parentId", r.claimed_sender AS "claimedSender", r.verified_sender AS "verifiedSender"
    FROM control.ticket_message m JOIN control.inbound_receipt r ON r.message_row_id = m.id
    WHERE m.ticket_id = ${id}::uuid AND m.direction = 'inbound' AND r.outcome = 'accept'
    ORDER BY m.sequence LIMIT 1`;
  return origin ?? null;
}

async function findTicket(tx: Prisma.TransactionClient, id: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT id FROM control.ticket WHERE id = ${id}::uuid FOR UPDATE`;
  const ticket = await tx.ticket.findUnique({ where: { id }, select: ticketFields });
  if (!ticket) throw new NotFoundException();
  return ticket;
}

export class TicketService {
  constructor(private readonly staff: StaffAccess) {}

  list(cookie: string, { cursor, limit, status }: z.infer<typeof ticketListPage>) {
    return this.staff.withPermission(cookie, 'cc.ticket.read', async (tx) => {
      const rows = await tx.ticket.findMany({ where: { id: { gt: cursor }, status },
        orderBy: { id: 'asc' }, take: limit + 1, select: ticketFields });
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    });
  }

  detail(cookie: string, id: string, { cursor, limit }: z.infer<typeof ticketMessagePage>) {
    return this.staff.withPermission(cookie, 'cc.ticket.read', async (tx, actor) => {
      const ticket = await findTicket(tx, id);
      const messages = await tx.ticketMessage.findMany({ where: { ticketId: id, OR: [
        { direction: 'internal', visibility: 'staff' },
        { direction: { in: ['inbound', 'outbound'] }, visibility: 'public' },
      ], sequence: { gt: cursor } }, orderBy: { sequence: 'asc' },
        take: limit + 1, select: messageFields });
      const items = messages.slice(0, limit).map(messageWithState);
      const target = controlPermissionSatisfied(actor.grants, 'cc.ticket.reply') ? replyTarget(await firstAcceptedOrigin(tx, id)) : null;
      return { ...ticket, replyTarget: target, messages: { items, nextCursor: messages.length > limit ? items[items.length - 1].sequence : null } };
    });
  }

  update(cookie: string, id: string, change: z.infer<typeof ticketPatch>) {
    return this.staff.withPermission(cookie, 'cc.ticket.manage', async (tx, actor) => {
      const current = await findTicket(tx, id, true);
      const businessId = change.businessId === undefined ? current.businessId : change.businessId;
      // A new business does not inherit the previous business's outlet.
      const outletId = change.outletId === undefined && businessId === current.businessId ? current.outletId : change.outletId ?? null;
      const ownerId = change.ownerId === undefined ? current.ownerId : change.ownerId;
      const next = { businessId, outletId, ownerId, status: change.status ?? current.status, priority: change.priority ?? current.priority };
      const fields = (Object.keys(next) as (keyof typeof next)[]).filter((key) => next[key] !== current[key]);
      if (fields.length === 0) return { id };

      if (outletId) {
        const scoped = businessId && await tx.outlet.findUnique({
          where: { businessId_id: { businessId, id: outletId } }, select: { id: true },
        });
        if (!scoped) throw new BadRequestException();
      } else if (businessId && !await tx.business.findUnique({ where: { id: businessId }, select: { id: true } })) {
        throw new BadRequestException();
      }
      if (ownerId && ownerId !== current.ownerId) {
        const owner = await tx.staff.findUnique({ where: { id: ownerId }, select: { enabled: true, grants: true } });
        if (!owner?.enabled || !controlPermissionSatisfied(owner.grants, 'cc.ticket.read')) throw new BadRequestException();
      }

      await tx.ticket.update({ where: { id }, data: { ...next,
        updatedAt: new Date(Math.max(current.updatedAt.getTime(), Date.now())) }, select: { id: true } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId,
        action: fields.includes('status') ? 'ticket.status.' + next.status : 'ticket.update',
        subjectType: 'ticket', subjectId: id, requestId: randomUUID(), outcome: 'succeeded', changedFields: fields });
      return { id };
    }, { staffTarget: change.ownerId ?? undefined });
  }

  reply(cookie: string, id: string, { text, requestKey, acknowledgeUnverified = false }: z.infer<typeof ticketReply>) {
    return this.staff.withPermission(cookie, 'cc.ticket.reply', async (tx, actor) => {
      const ticket = await findTicket(tx, id, true);
      const previous = await tx.ticketMessage.findUnique({
        where: { ticketId_requestKey: { ticketId: id, requestKey } },
        select: { ...noteFields, replyOutbox: { select: { state: true, acknowledgedUnverified: true } } },
      });
      if (previous) {
        if (previous.direction !== 'outbound' || previous.visibility !== 'public' ||
            previous.replyOutbox?.acknowledgedUnverified !== acknowledgeUnverified || previous.text !== text) {
          throw new ConflictException();
        }
        return messageWithState(previous);
      }

      const origin = await firstAcceptedOrigin(tx, id);
      const target = replyTarget(origin);
      if (!origin || !target) throw new ConflictException();
      if (!target.verified && !acknowledgeUnverified) throw new ForbiddenException();

      const row = randomUUID();
      const subject = ticket.subject.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim() || 'Support ticket';
      const rendered = renderTicketReply({
        subject: /^re:/i.test(subject) ? subject : 'Re: ' + subject, customerName: 'there', body: text,
      });
      await tx.$executeRaw`SELECT control.enqueue_ticket_reply(
        ${row}::uuid, ${id}::uuid, ${origin.parentId}::uuid, ${actor.id}::uuid, ${requestKey}::uuid, ${text},
        ${'<' + row + '@nventra.invalid>'}, ${rendered.subject}, ${rendered.text}, ${rendered.html}, ${acknowledgeUnverified})`;
      const queued = await tx.ticketMessage.findUniqueOrThrow({ where: { id: row }, select: messageFields });
      await tx.ticket.update({ where: { id }, data: {
        updatedAt: new Date(Math.max(ticket.updatedAt.getTime(), queued.createdAt.getTime())),
      }, select: { id: true } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId: ticket.businessId,
        action: 'ticket.reply.queue', subjectType: 'ticket', subjectId: id, requestId: requestKey,
        outcome: 'succeeded', changedFields: acknowledgeUnverified ? ['reply', 'acknowledgeUnverified'] : ['reply'] });
      return messageWithState(queued);
    });
  }

  addNote(cookie: string, id: string, { text, requestKey }: z.infer<typeof ticketNote>) {
    return this.staff.withPermission(cookie, 'cc.ticket.manage', async (tx, actor) => {
      const ticket = await findTicket(tx, id, true);
      const existing = await tx.ticketMessage.findUnique({ where: { ticketId_requestKey: { ticketId: id, requestKey } }, select: noteFields });
      if (existing) {
        if (existing.direction !== 'internal' || existing.visibility !== 'staff' || existing.text !== text) throw new ConflictException();
        return existing;
      }
      const latest = await tx.ticketMessage.findFirst({ where: { ticketId: id }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      const note = await tx.ticketMessage.create({ data: { id: randomUUID(), ticketId: id, text,
        requestKey, authorId: actor.id, sequence: (latest?.sequence ?? 0) + 1 }, select: noteFields });
      await tx.ticket.update({ where: { id }, data: { updatedAt: new Date(Math.max(ticket.updatedAt.getTime(), note.createdAt.getTime())) }, select: { id: true } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId: ticket.businessId,
        action: 'ticket.note.add', subjectType: 'ticket', subjectId: id, requestId: requestKey, outcome: 'succeeded', changedFields: ['note'] });
      return note;
    });
  }
}
