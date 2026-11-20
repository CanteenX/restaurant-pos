import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { portalTicketOpen, portalTicketStaffReply } from '@nventra/types/dist/control-portal-ticket';
import { Prisma } from '../../../node_modules/.prisma/control-client/index.js';

type Tx = Prisma.TransactionClient;
type TicketHeader = { id: string; subject: string; status: string; outletId: string | null; updatedAt: Date };
type PortalMessage = { id: string; text: string; sequence: number; direction: 'inbound' | 'outbound'; createdAt: Date };

async function headers(tx: Tx, limit: number, id?: string, cursor?: string) {
  return tx.$queryRaw<TicketHeader[]>`
    SELECT id, subject, status, outlet_id AS "outletId", updated_at AS "updatedAt"
    FROM control.portal_ticket_header
    WHERE (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid)
      AND (${cursor ?? null}::uuid IS NULL OR id>${cursor ?? null}::uuid)
    ORDER BY id LIMIT ${limit}`;
}

export async function listPortalTickets(tx: Tx, { limit, cursor }: { limit: number; cursor?: string }) {
  const rows = await headers(tx, limit + 1, undefined, cursor);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[limit - 1].id : null };
}

export async function readPortalTicket(tx: Tx, id: string, { limit, cursor }: { limit: number; cursor?: number }) {
  const [ticket] = await headers(tx, 1, id);
  if (!ticket) throw new NotFoundException();
  const rows = await tx.$queryRaw<PortalMessage[]>`
    SELECT id, body AS text, sequence, direction, created_at AS "createdAt" FROM control.portal_ticket_conversation
    WHERE ticket_id=${id}::uuid AND sequence>${cursor ?? 0} ORDER BY sequence LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  return { ...ticket, messages: { items, nextCursor: rows.length > limit ? items[limit - 1].sequence : null } };
}

export async function ownsPortalTicket(tx: Tx, id: string) {
  const [row] = await tx.$queryRaw<{ owned: boolean }[]>`SELECT control.portal_owns_ticket(${id}::uuid) AS owned`;
  return row?.owned === true;
}

function requestError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.meta?.code === 'NV400') throw new BadRequestException();
    if (error.meta?.code === 'NV409') throw new ConflictException();
    if (error.meta?.code === 'NV403') throw new ForbiddenException();
    if (error.meta?.code === 'NV429') throw new HttpException('Too many portal tickets', 429);
  }
  throw error;
}

export async function openPortalTicket(tx: Tx, draft: z.infer<typeof portalTicketOpen>) {
  try {
    const [{ id }] = await tx.$queryRaw<{ id: string }[]>`SELECT control.portal_open_ticket(
      ${draft.requestKey}::uuid, ${draft.outletId ?? null}::uuid, ${draft.subject}, ${draft.text}) AS id`;
    return { id };
  } catch (error) { return requestError(error); }
}

export async function publishPortalReply(tx: Tx, ticketId: string, actorId: string, reply: z.infer<typeof portalTicketStaffReply>) {
  try {
    const [{ id }] = await tx.$queryRaw<{ id: string | null }[]>`SELECT control.publish_portal_ticket_reply(
      ${ticketId}::uuid, ${actorId}::uuid, ${reply.requestKey}::uuid, ${reply.text}) AS id`;
    if (!id) throw new NotFoundException();
    return { id };
  } catch (error) { return requestError(error); }
}
