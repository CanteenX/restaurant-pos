import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { canManageControlStaff, controlGrantTweaks, effectiveControlGrants,
  type controlRoleCreate, type controlRoleUpdate, type controlStaffRoleAssignment } from '@nventra/types';
import type { z } from 'zod';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';
import type { StaffAccess } from './staff-access.js';

const roleFields = { id: true, key: true, name: true, description: true, grants: true, isSystem: true, updatedAt: true,
  _count: { select: { members: true } } } as const;
const memberFields = { id: true, grants: true, extraGrants: true, removedGrants: true } as const;
const holds = (actor: readonly string[], wanted: readonly string[]) => wanted.every((key) => actor.includes(key));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && holds(a, b);

type Tx = Prisma.TransactionClient;
const audit = (tx: Tx, actorId: string, action: string, subjectType: string, subjectId: string, changedFields: string[]) =>
  appendAuditEvent(tx, { actorType: 'staff', actorId, action, subjectType, subjectId, requestId: randomUUID(),
    outcome: 'succeeded', changedFields });

/** Refuses a change that would leave no enabled member in a locked system (Admin) role. */
export async function ensureAnotherAdmin(tx: Tx, leaving: string) {
  const others = await tx.staff.count({ where: { id: { not: leaving }, enabled: true, role: { isSystem: true } } });
  if (others === 0) throw new ConflictException();
}

/** Role administration. Authorization uses permission keys held by the actor, never role names. */
export class RoleAccess {
  constructor(private readonly access: StaffAccess) {}

  list(cookie: string, page: { cursor?: string; limit: number }) {
    return this.access.withPermission(cookie, 'cc.staff.read', async (tx) => {
      const rows = await tx.staffRole.findMany({ where: { id: { gt: page.cursor } }, orderBy: { id: 'asc' },
        take: page.limit + 1, select: roleFields });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items[items.length - 1].id : null };
    });
  }

  create(cookie: string, dto: z.infer<typeof controlRoleCreate>) {
    return this.access.withPermission(cookie, 'cc.role.manage', async (tx, actor) => {
      if (!holds(actor.grants, dto.grants)) throw new ForbiddenException();
      if (await tx.staffRole.findUnique({ where: { key: dto.key }, select: { id: true } })) throw new ConflictException();
      const role = await tx.staffRole.create({ data: { ...dto, updatedBy: actor.id }, select: roleFields });
      await audit(tx, actor.id, 'role.create', 'staff_role', role.id, ['key', 'name', 'description', 'grants']);
      return role;
    }, { recent: true, serialize: true });
  }

  update(cookie: string, id: string, dto: z.infer<typeof controlRoleUpdate>) {
    return this.access.withPermission(cookie, 'cc.role.manage', async (tx, actor) => {
      await tx.$queryRaw`SELECT id FROM control.staff_role WHERE id = ${id}::uuid FOR UPDATE`;
      const role = await tx.staffRole.findUnique({ where: { id } });
      if (!role) throw new NotFoundException();
      if (role.isSystem) throw new ForbiddenException();
      const members = await tx.staff.findMany({ where: { roleId: id }, select: memberFields });
      // An actor cannot edit a role holding permissions it lacks, add any it lacks, or reach members above it.
      if (!holds(actor.grants, role.grants) || !holds(actor.grants, dto.grants ?? role.grants) ||
          !members.every((m) => holds(actor.grants, m.grants))) throw new ForbiddenException();
      const changed = (Object.keys(dto) as (keyof typeof dto)[]).filter((k) =>
        k === 'grants' ? !same(role.grants, dto.grants ?? []) : dto[k] !== role[k]);
      const updated = await tx.staffRole.update({ where: { id }, data: { ...dto, updatedAt: new Date(), updatedBy: actor.id },
        select: roleFields });
      for (const member of members) { // live propagation, in this same transaction
        const grants = effectiveControlGrants(updated.grants, member.extraGrants, member.removedGrants);
        if (same(grants, member.grants)) continue;
        await tx.staff.update({ where: { id: member.id }, data: { grants } });
        await audit(tx, actor.id, 'staff.grants.replace', 'staff', member.id, ['grants']);
      }
      await audit(tx, actor.id, 'role.update', 'staff_role', id, changed);
      return updated;
    }, { recent: true, serialize: true, roleMembers: id });
  }

  remove(cookie: string, id: string) {
    return this.access.withPermission(cookie, 'cc.role.manage', async (tx, actor) => {
      await tx.$queryRaw`SELECT id FROM control.staff_role WHERE id = ${id}::uuid FOR UPDATE`;
      const role = await tx.staffRole.findUnique({ where: { id }, select: roleFields });
      if (!role) throw new NotFoundException();
      if (role.isSystem || !holds(actor.grants, role.grants)) throw new ForbiddenException();
      if (role._count.members > 0) throw new ConflictException();
      await tx.staffRole.delete({ where: { id } });
      await audit(tx, actor.id, 'role.delete', 'staff_role', id, ['key']);
      return { id, deleted: true };
    }, { recent: true, serialize: true, roleMembers: id });
  }

  assign(cookie: string, id: string, dto: z.infer<typeof controlStaffRoleAssignment>) {
    return this.access.withPermission(cookie, 'cc.staff.manage', async (tx, actor) => {
      const subject = await tx.staff.findUnique({ where: { id },
        select: { id: true, grants: true, roleId: true, role: { select: { isSystem: true } } } });
      const role = await tx.staffRole.findUnique({ where: { id: dto.roleId } });
      if (!subject || !role) throw new NotFoundException();
      if (role.isSystem && (dto.extraGrants.length > 0 || dto.removedGrants.length > 0)) throw new BadRequestException();
      const next = effectiveControlGrants(role.grants, dto.extraGrants, dto.removedGrants);
      if (!canManageControlStaff({ staffId: actor.id, grants: actor.grants }, { staffId: subject.id, grants: subject.grants }, next) ||
          !holds(actor.grants, role.grants)) throw new ForbiddenException();
      if (subject.role?.isSystem && subject.roleId !== role.id) await ensureAnotherAdmin(tx, subject.id);
      const staff = await tx.staff.update({ where: { id }, select: { id: true, email: true, enabled: true, grants: true, roleId: true },
        data: { roleId: role.id, grants: next, ...controlGrantTweaks(role.grants, next) } });
      await audit(tx, actor.id, 'staff.role.assign', 'staff', id, ['roleId', 'extraGrants', 'removedGrants', 'grants']);
      return staff;
    }, { recent: true, staffTarget: id, serialize: true });
  }
}
