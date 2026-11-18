import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { controlPermissionSatisfied, type ticketListPage, type ticketMessagePage, type ticketNote, type ticketPatch } from '@nventra/types';
import type { z } from 'zod';
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
    return this.staff.withPermission(cookie, 'cc.ticket.read', async (tx) => {
      const ticket = await findTicket(tx, id);
      const notes = await tx.ticketMessage.findMany({ where: { ticketId: id, direction: 'internal',
        visibility: 'staff', sequence: { gt: cursor } }, orderBy: { sequence: 'asc' },
        take: limit + 1, select: noteFields });
      const items = notes.slice(0, limit);
      return { ...ticket, messages: { items, nextCursor: notes.length > limit ? items[items.length - 1].sequence : null } };
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
