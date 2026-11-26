import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { businessCreate, businessPatch, outletCreate, outletPatch } from '@nventra/types';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';
import type { StaffAccess } from '../staff/staff-access.js';

type RegistryFields = { legalName?: string; displayName?: string; timeZone?: string; archived?: boolean };
type Page = { cursor?: string; limit: number };
function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[limit - 1].id : null };
}
function found<T>(row: T | null | undefined) {
  if (!row) throw new NotFoundException();
  return row;
}

async function previousFields(tx: Prisma.TransactionClient, businessId?: string, id?: string): Promise<RegistryFields> {
  if (!id) return {};
  const rows = businessId
    ? await tx.$queryRaw<RegistryFields[]>`SELECT display_name AS "displayName", time_zone AS "timeZone", archived
        FROM control.outlet WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid FOR UPDATE`
    : await tx.$queryRaw<RegistryFields[]>`SELECT legal_name AS "legalName", display_name AS "displayName", archived
        FROM control.business WHERE id = ${id}::uuid FOR UPDATE`;
  return found(rows[0]);
}

export class BusinessRegistry {
  constructor(private readonly access: StaffAccess) {}

  businesses(cookie: string, { cursor, limit }: Page) {
    return this.access.withPermission(cookie, 'cc.business.read', async (tx) => pageOf(await tx.business.findMany({
      where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: limit + 1,
    }), limit));
  }

  business(cookie: string, id: string) {
    return this.access.withPermission(cookie, 'cc.business.read', async (tx) => found(await tx.business.findUnique({ where: { id } })));
  }

  outlets(cookie: string, businessId: string, { cursor, limit }: Page) {
    return this.access.withPermission(cookie, 'cc.business.read', async (tx) => {
      found(await tx.business.findUnique({ where: { id: businessId }, select: { id: true } }));
      return pageOf(await tx.outlet.findMany({ where: { businessId, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: limit + 1 }), limit);
    });
  }

  outlet(cookie: string, businessId: string, id: string) {
    return this.access.withPermission(cookie, 'cc.business.read', async (tx) => found(await tx.outlet.findUnique({
      where: { businessId_id: { businessId, id } },
    })));
  }

  private write<T extends { id: string }>(cookie: string, fields: RegistryFields, businessId: string | undefined,
    previousId: string | undefined, apply: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.access.withPermission(cookie, 'cc.business.manage', async (tx, actor) => {
      const parent = businessId && found((await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM control.business
        WHERE id = ${businessId}::uuid FOR SHARE`)[0]);
      const before = await previousFields(tx, businessId, previousId);
      if (parent && parent.archived) throw new ConflictException('Business is archived');
      const changedFields = (Object.keys(fields) as (keyof RegistryFields)[]).filter((key) => fields[key] !== before[key]).sort();
      const operation = previousId ? 'update' : 'create';
      const saved = await apply(tx);
      const subjectType = businessId ? 'outlet' : 'business';
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId: businessId ?? saved.id,
        action: subjectType + '.' + operation, subjectType, subjectId: saved.id, requestId: randomUUID(),
        outcome: 'succeeded', changedFields });
      return saved;
    });
  }

  createBusiness(cookie: string, data: z.infer<typeof businessCreate>) {
    return this.write(cookie, data, undefined, undefined, (tx) => tx.business.create({ data: { ...data, id: randomUUID() } }));
  }
  updateBusiness(cookie: string, id: string, data: z.infer<typeof businessPatch>) {
    return this.write(cookie, data, undefined, id, (tx) => tx.business.update({ where: { id }, data }));
  }
  createOutlet(cookie: string, businessId: string, data: z.infer<typeof outletCreate>) {
    return this.write(cookie, data, businessId, undefined, (tx) => tx.outlet.create({ data: { ...data, businessId, id: randomUUID() } }));
  }
  updateOutlet(cookie: string, businessId: string, id: string, data: z.infer<typeof outletPatch>) {
    return this.write(cookie, data, businessId, id, (tx) => tx.outlet.update({
      where: { businessId_id: { businessId, id } }, data,
    }));
  }
}
