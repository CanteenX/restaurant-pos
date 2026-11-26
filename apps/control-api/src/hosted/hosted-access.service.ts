import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';
import type { StaffAccess } from '../staff/staff-access.js';
import { decideHostedPatch, type HostedAccessPatch } from './hosted-access-policy.js';

type Entry = HostedAccessPatch & { actorId: string; revision: number; changedAt: Date };

async function latest(tx: Prisma.TransactionClient, businessId: string): Promise<Entry | undefined> {
  const [entry] = await tx.$queryRaw<Entry[]>`
    SELECT status, reason, request_key AS "requestKey", actor_id AS "actorId", revision, changed_at AS "changedAt"
    FROM control.hosted_access_event WHERE business_id = ${businessId}::uuid ORDER BY revision DESC LIMIT 1`;
  return entry;
}

function view(entry?: Entry) {
  return entry ? { status: entry.status, reason: entry.reason, version: entry.requestKey, changedAt: entry.changedAt.toISOString() }
    : { status: 'active' as const, version: '0' };
}

export class HostedAccessService {
  constructor(private readonly access: StaffAccess) {}

  read(cookie: string, businessId: string) {
    return this.access.withPermission(cookie, 'cc.hosted.read', async (tx) => {
      const business = await tx.business.findUnique({ where: { id: businessId }, select: { id: true } });
      if (!business) throw new NotFoundException();
      return view(await latest(tx, businessId));
    });
  }

  write(cookie: string, businessId: string, expected: string, patch: HostedAccessPatch) {
    return this.access.withPermission(cookie, 'cc.hosted.manage', async (tx, actor) => {
      const [business] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM control.business
        WHERE id = ${businessId}::uuid FOR UPDATE`;
      if (!business) throw new NotFoundException();

      const [original] = await tx.$queryRaw<Entry[]>`
        SELECT status, reason, request_key AS "requestKey", actor_id AS "actorId", revision, changed_at AS "changedAt"
        FROM control.hosted_access_event WHERE business_id = ${businessId}::uuid AND request_key = ${patch.requestKey}::uuid`;
      const current = await latest(tx, businessId);
      const decision = decideHostedPatch(actor.id, patch, expected, current?.requestKey ?? '0', original);
      if (decision === 'replay') return view(original);
      if (decision === 'conflict' || business.archived) throw new ConflictException();
      if (decision === 'stale') throw new HttpException('Hosted access changed', 412);

      const [saved] = await tx.$queryRaw<Entry[]>`
        INSERT INTO control.hosted_access_event(business_id, request_key, actor_id, status, reason, revision)
        VALUES (${businessId}::uuid, ${patch.requestKey}::uuid, ${actor.id}::uuid, ${patch.status}, ${patch.reason}, ${(current?.revision ?? 0) + 1})
        RETURNING status, reason, request_key AS "requestKey", actor_id AS "actorId", revision, changed_at AS "changedAt"`;
      const changedFields = [
        ...((current?.status ?? 'active') !== patch.status ? ['hostedStatus'] : []),
        ...(current?.reason !== patch.reason ? ['hostedReason'] : []),
      ];
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId,
        action: patch.status === 'suspended' ? 'hostedAccess.suspend' : 'hostedAccess.restore',
        subjectType: 'business', subjectId: businessId, requestId: patch.requestKey,
        outcome: 'succeeded', changedFields });
      return view(saved);
    }, { recent: true });
  }
}
