import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';

type Tx = Prisma.TransactionClient;
type Snapshot = { id: string; displayName: string; hostedStatus: 'active' | 'suspended' };
type Outlet = { id: string; displayName: string; timeZone: string; label: string | null; startsAt: Date | null; endsAt: Date | null };

export async function portalBusiness(tx: Tx, businessId: string, paid = false) {
  const [row] = await tx.$queryRaw<Snapshot[]>`SELECT id, display_name AS "displayName", hosted_status AS "hostedStatus"
    FROM control.portal_business_snapshot()`;
  if (!row || row.id !== businessId) throw new NotFoundException();
  if (paid && row.hostedStatus !== 'active') throw new ForbiddenException();
  return row;
}

export async function portalOutlets(tx: Tx, businessId: string, page: { limit: number; cursor?: string }) {
  const cursor = page.cursor ?? null;
  const rows = await tx.$queryRaw<Outlet[]>`SELECT id, display_name AS "displayName", time_zone AS "timeZone",
    label, starts_at AS "startsAt", ends_at AS "endsAt" FROM control.portal_outlet
    WHERE business_id = ${businessId}::uuid AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
    ORDER BY id LIMIT ${page.limit + 1}`;
  const items = rows.slice(0, page.limit).map(({ id, displayName, timeZone, label, startsAt, endsAt }) => ({
    id, displayName, timeZone, plan: label && startsAt && endsAt ? { label, startsAt, endsAt } : null
  }));
  return { items, nextCursor: rows.length > page.limit ? items[items.length - 1].id : null };
}
