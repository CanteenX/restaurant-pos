import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { OutletServiceTerm, Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';
import type { StaffAccess } from '../staff/staff-access.js';

// A cancellation closes every open term for this outlet at recordedAt, including scheduled renewals.
type Mutation = { operation: 'cancel'; requestKey: string } | {
  operation: 'assign' | 'renew'; requestKey: string; planCode: string; planVersion: number;
  startsAt: Date; endsAt: Date;
};
type Page = { cursor?: number; limit: number };

async function outletScope(tx: Prisma.TransactionClient, id: string) {
  const outlet = await tx.outlet.findUnique({ where: { id }, select: { businessId: true } });
  if (!outlet) throw new NotFoundException();
  return { businessId: outlet.businessId, outletId: id };
}

function matches(existing: OutletServiceTerm, change: Mutation) {
  return existing.operation === change.operation && (change.operation === 'cancel' ||
    (existing.planCode === change.planCode && existing.planVersion === change.planVersion &&
      existing.startsAt?.getTime() === change.startsAt.getTime() && existing.endsAt?.getTime() === change.endsAt.getTime()));
}

function checkPeriod(latest: OutletServiceTerm | null, change: Mutation, now: Date) {
  const previousEnd = latest?.endsAt;
  if (change.operation === 'cancel') {
    if (!previousEnd || previousEnd <= now) throw new ConflictException();
    return;
  }
  if (change.endsAt <= now || (change.operation === 'renew' && !previousEnd) ||
    (change.operation === 'assign' && previousEnd && previousEnd > now) ||
    (previousEnd && change.startsAt < previousEnd) ||
    (latest?.operation === 'cancel' && change.startsAt < latest.recordedAt)) throw new ConflictException();
}

export class ServicePlans {
  constructor(private readonly staff: StaffAccess) {}

  catalog(cookie: string) {
    return this.staff.withPermission(cookie, 'cc.plan.read', (tx) =>
      tx.servicePlanVersion.findMany({ orderBy: [{ code: 'asc' }, { version: 'desc' }] }));
  }

  history(cookie: string, id: string, { cursor, limit }: Page) {
    return this.staff.withPermission(cookie, 'cc.plan.read', async (tx) => {
      const scope = await outletScope(tx, id);
      const rows = await tx.outletServiceTerm.findMany({ where: { ...scope, revision: { lt: cursor } },
        orderBy: { revision: 'desc' }, take: limit + 1 });
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].revision : null };
    });
  }

  change(cookie: string, id: string, change: Mutation) {
    return this.staff.withPermission(cookie, 'cc.plan.manage', async (tx, actor) => {
      const scope = await outletScope(tx, id);
      // Match registry lock order and serialize all changes for this outlet.
      const [parent] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM control.business
        WHERE id = ${scope.businessId}::uuid FOR SHARE`;
      const [outlet] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM control.outlet
        WHERE business_id = ${scope.businessId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!parent || !outlet) throw new NotFoundException();

      const { requestKey, operation } = change;
      const existing = await tx.outletServiceTerm.findUnique({ where: { businessId: scope.businessId, outletId_requestKey: { outletId: id, requestKey } } });
      if (existing) {
        if (!matches(existing, change)) throw new ConflictException();
        return existing;
      }

      const now = new Date();
      const latest = await tx.outletServiceTerm.findFirst({ where: scope, orderBy: { revision: 'desc' } });
      checkPeriod(latest, change, now);
      if (operation !== 'cancel') {
        if (parent.archived || outlet.archived) throw new ConflictException();
        const version = await tx.servicePlanVersion.findUnique({
          where: { code_version: { code: change.planCode, version: change.planVersion } },
        });
        if (!version) throw new NotFoundException();
      }

      const terms = operation === 'cancel' ? {} : {
        planCode: change.planCode, planVersion: change.planVersion, startsAt: change.startsAt, endsAt: change.endsAt,
      };
      const result = await tx.outletServiceTerm.create({ data: { ...scope, ...terms, id: randomUUID(),
        revision: (latest?.revision ?? 0) + 1, requestKey, operation, recordedAt: now } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId: scope.businessId,
        action: 'servicePlan.' + operation, subjectType: 'outlet', subjectId: id, requestId: requestKey,
        outcome: 'succeeded', changedFields: Object.keys(terms) });
      return result;
    }, { recent: true });
  }
}
