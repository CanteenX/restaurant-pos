import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { canManageControlStaff, controlGrantTweaks, controlPermissionSatisfied, type ControlPermissionKey } from '@nventra/types';
import type { Prisma, PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';

const directoryFields = { id: true, email: true, enabled: true, grants: true } as const;
type Actor = { id: string; grants: string[]; role: { isSystem: boolean } | null };
type Mutation = { kind: 'grants'; grants: ControlPermissionKey[] } | { kind: 'reset' | 'revoke' };
/** `serialize` takes the single role-administration lock first; `roleMembers` also row-locks every member of that role. */
type Options = { recent?: boolean; staffTarget?: string; serialize?: boolean; roleMembers?: string; alternative?: ControlPermissionKey };

export class StaffAccess {
  constructor(private readonly db: PrismaClient, private readonly sessionDigest: (cookie: string) => string) {}

  async withPermission<T>(cookie: string, permission: ControlPermissionKey,
    run: (tx: Prisma.TransactionClient, actor: Actor) => Promise<T>, options: Options = {}) {
    const digest = this.sessionDigest(cookie);
    return this.db.$transaction(async (tx) => {
      // Lock order is always: role-administration lock, then staff rows by id, then role rows.
      if (options.serialize) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('control.staff_roles'))`;
      const initial = await tx.staffSession.findUnique({ where: { digest }, select: { staffId: true } });
      if (!initial) throw new UnauthorizedException();
      // Order all principals consistently, then re-read grants and session after any competing commit.
      await tx.$queryRaw`SELECT id FROM control.staff WHERE id IN
        (${initial.staffId}::uuid, ${options.staffTarget ?? initial.staffId}::uuid)
        OR role_id = ${options.roleMembers ?? null}::uuid ORDER BY id FOR UPDATE`;
      const now = new Date();
      const session = await tx.staffSession.findFirst({ where: { digest, staffId: initial.staffId,
        expiresAt: { gt: now }, verifiedAt: { lte: now }, staff: { enabled: true } },
        select: { verifiedAt: true, staff: { select: { id: true, grants: true, role: { select: { isSystem: true } } } } } });
      if (!session) throw new UnauthorizedException();
      if (!(controlPermissionSatisfied(session.staff.grants, permission) ||
          (options.alternative && controlPermissionSatisfied(session.staff.grants, options.alternative))) ||
          (options.recent && now.getTime() - session.verifiedAt.getTime() > 10 * 60_000)) throw new ForbiddenException();
      return run(tx, session.staff);
    });
  }

  list(cookie: string, page: { cursor?: string; limit: number }) {
    return this.withPermission(cookie, 'cc.staff.read', async (tx) => {
      const rows = await tx.staff.findMany({ where: { id: { gt: page.cursor } }, orderBy: { id: 'asc' },
        take: page.limit + 1, select: { ...directoryFields, name: true, lastSignInAt: true, roleId: true, encryptedSeed: true } });
      const items = rows.slice(0, page.limit).map(({ encryptedSeed, ...staff }) => ({ ...staff, twoFactorEnabled: encryptedSeed !== null }));
      return { items, nextCursor: rows.length > page.limit ? items[items.length - 1].id : null };
    });
  }

  change(cookie: string, id: string, mutation: Mutation) {
    return this.withPermission(cookie, 'cc.staff.manage', async (tx, actor) => {
      const subject = await tx.staff.findUnique({ where: { id }, select: { id: true, grants: true, role: { select: { grants: true } } } });
      if (!subject) throw new NotFoundException();
      const requested = mutation.kind === 'grants' ? mutation.grants : subject.grants;
      if (!canManageControlStaff({ staffId: actor.id, grants: actor.grants },
        { staffId: subject.id, grants: subject.grants }, requested)) throw new ForbiddenException();

      // Replacing grants is recorded as per-person tweaks on top of the member's role, keeping role + tweaks = grants.
      const data: Prisma.StaffUpdateInput = mutation.kind === 'grants'
        ? { grants: mutation.grants, ...(subject.role ? controlGrantTweaks(subject.role.grants, mutation.grants) : {}) }
        : { credentialVersion: { increment: 1 } };
      if (mutation.kind === 'reset') Object.assign(data, { encryptedSeed: null, lastStep: null, recoveryDigests: [] });
      const staff = await tx.staff.update({ where: { id: subject.id }, data, select: directoryFields });
      const action = { grants: 'staff.grants.replace', revoke: 'staff.sessions.revoke', reset: 'staff.factor.reset' }[mutation.kind];
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, action, subjectType: 'staff', subjectId: subject.id,
        requestId: randomUUID(), outcome: 'succeeded', changedFields: mutation.kind === 'grants' ? ['grants'] : [] });
      return staff;
    }, { recent: true, staffTarget: id, serialize: true });
  }
}
