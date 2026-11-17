import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateStaffDto,
  DepartmentDto,
  SessionUser,
  SetPermissionOverridesDto,
  UpdateStaffDto,
} from '@nventra/types';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../auth/session.service';
import {
  OWNER_ROLE,
  assertCanAssignRole,
  assertCanManage,
  assertCanManageRole,
  assertCanResetCredentials,
  canGrant,
  canManageRole,
  ceilingRoleInclude,
  ceilingUserInclude,
  isOwner,
  loadCeilingActor,
  type CeilingActor,
} from '../../common/privilege-ceiling';

/** Target of an edit: ceiling data plus what self-edit rules compare. */
const updateTargetInclude = {
  ...ceilingUserInclude,
  branches: { select: { branchId: true } },
} as const;

type UpdateTarget = Prisma.UserGetPayload<{
  include: typeof updateTargetInclude;
}>;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

const SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  createdAt: true,
  roleId: true,
  role: { select: { id: true, name: true, label: true } },
  departmentId: true,
  department: { select: { id: true, name: true } },
  permissionOverrides: {
    select: {
      effect: true,
      reason: true,
      expiresAt: true,
      permission: { select: { key: true } },
    },
  },
  branches: { select: { branch: { select: { id: true, name: true } } } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  list(restaurantId: string) {
    return this.prisma.user.findMany({
      where: { restaurantId },
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Roles for the staff-create picker: only the ones the actor may assign
   * (#229), so a manager never sees OWNER or a role above their own access.
   */
  async listRoles(restaurantId: string, actor: SessionUser) {
    const me = await loadCeilingActor(this.prisma, actor, restaurantId);
    const roles = await this.prisma.role.findMany({
      where: { restaurantId },
      orderBy: { label: 'asc' },
      include: ceilingRoleInclude,
    });
    return roles
      .filter((role) => canManageRole(me, role))
      .map(({ id, restaurantId: rid, name, label, isSystem, createdAt }) => ({
        id,
        restaurantId: rid,
        name,
        label,
        isSystem,
        createdAt,
      }));
  }

  async create(restaurantId: string, actor: SessionUser, dto: CreateStaffDto) {
    const me = await loadCeilingActor(this.prisma, actor, restaurantId);
    const role = await this.assertRoleInRestaurant(restaurantId, dto.roleId);
    // #229: you can only create an account at or below your own access.
    assertCanManageRole(me, role);
    await this.assertBranchesInRestaurant(restaurantId, dto.branchIds);
    await this.assertDepartmentInRestaurant(restaurantId, dto.departmentId);

    if (dto.email) {
      const existing = await this.prisma.user.findFirst({
        where: { restaurantId, email: dto.email },
      });
      if (existing) {
        throw new ConflictException(
          'A staff account with this email already exists',
        );
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        restaurantId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        roleId: dto.roleId,
        departmentId: dto.departmentId ?? undefined,
        passwordHash,
        branches: {
          create: dto.branchIds.map((branchId) => ({ branchId })),
        },
      },
      select: SELECT,
    });

    await this.audit.record({
      userId: actor.id,
      action: 'staff.created',
      entity: 'User',
      entityId: user.id,
      metadata: { name: user.name, email: user.email, roleId: user.roleId },
    });

    return user;
  }

  async update(
    restaurantId: string,
    actor: SessionUser,
    id: string,
    dto: UpdateStaffDto,
  ) {
    const me = await loadCeilingActor(this.prisma, actor, restaurantId);
    const existing = await this.prisma.user.findFirst({
      where: { id, restaurantId },
      include: updateTargetInclude,
    });
    if (!existing) {
      throw new NotFoundException('Staff account not found');
    }
    // #229: editing (incl. disabling) needs at least the target's access;
    // changing a role also needs the new role's access.
    assertCanManage(me, existing);
    if (id === me.id) {
      await this.assertSelfEditAllowed(me, existing, dto);
    } else if (dto.password) {
      // #236: a password reset needs strictly more access than the target.
      assertCanResetCredentials(me, existing);
    }
    const roleChanged = Boolean(dto.roleId) && dto.roleId !== existing.roleId;
    if (roleChanged) {
      const nextRole = await this.assertRoleInRestaurant(
        restaurantId,
        dto.roleId!,
      );
      assertCanAssignRole(me, id, nextRole);
    }

    if (dto.branchIds) {
      await this.assertBranchesInRestaurant(restaurantId, dto.branchIds);
    }
    await this.assertDepartmentInRestaurant(restaurantId, dto.departmentId);

    const passwordHash = dto.password
      ? await bcrypt.hash(dto.password, 12)
      : undefined;

    const demotesOwner =
      existing.role.name === OWNER_ROLE &&
      (dto.isActive === false || roleChanged);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (demotesOwner) {
        await this.assertAnotherActiveOwner(
          tx,
          restaurantId,
          id,
          'Cannot disable or change the role of the last active owner',
        );
      }
      return tx.user.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          roleId: dto.roleId,
          departmentId: dto.departmentId,
          isActive: dto.isActive,
          passwordHash,
          ...(dto.branchIds
            ? {
                branches: {
                  deleteMany: {},
                  create: dto.branchIds.map((branchId) => ({ branchId })),
                },
              }
            : {}),
        },
        select: SELECT,
      });
    });

    // A new password or a disabled account ends every existing session.
    if (dto.password || dto.isActive === false) {
      await this.sessions.revokeAll(id);
    }

    // Never log `dto.password`/`passwordHash` — only the fields it's safe
    // for an owner reviewing history to see. `passwordChanged` is a boolean
    // flag, not the value, so a password rotation is still visible in the
    // trail without the audit log becoming a secondary place secrets leak.
    await this.audit.record({
      userId: actor.id,
      action: 'staff.updated',
      entity: 'User',
      entityId: id,
      metadata: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        roleId: dto.roleId,
        isActive: dto.isActive,
        branchIds: dto.branchIds,
        passwordChanged: Boolean(dto.password),
      },
    });

    return updated;
  }

  async remove(restaurantId: string, actor: SessionUser, id: string) {
    if (id === actor.id) {
      throw new BadRequestException('You cannot delete your own account');
    }

    const existing = await this.prisma.user.findFirst({
      where: { id, restaurantId },
      include: ceilingUserInclude,
    });
    if (!existing) {
      throw new NotFoundException('Staff account not found');
    }
    const me = await loadCeilingActor(this.prisma, actor, restaurantId);
    assertCanManage(me, existing);

    try {
      await this.prisma.$transaction(async (tx) => {
        if (existing.role.name === OWNER_ROLE) {
          await this.assertAnotherActiveOwner(
            tx,
            restaurantId,
            id,
            'Cannot delete the last active owner',
          );
        }
        await tx.user.delete({ where: { id } });
      });
    } catch (err) {
      // Order/Refund/PurchaseOrder/... all keep a required, non-cascading
      // reference to the staff member who created them, so history is never
      // silently lost. Once a staffer has touched a real order they can no
      // longer be hard-deleted — disable them instead (`isActive: false`).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        throw new BadRequestException(
          'This staff account has order, purchase, or inventory history and cannot be deleted. Disable it instead.',
        );
      }
      throw err;
    }

    await this.audit.record({
      userId: actor.id,
      action: 'staff.deleted',
      entity: 'User',
      entityId: id,
      metadata: { name: existing.name, email: existing.email },
    });

    return { ok: true };
  }

  // --- Departments ---------------------------------------------------------

  listDepartments(restaurantId: string) {
    return this.prisma.department.findMany({
      where: { restaurantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: true } } },
    });
  }

  async createDepartment(
    restaurantId: string,
    actorId: string,
    dto: DepartmentDto,
  ) {
    try {
      const dept = await this.prisma.department.create({
        data: { restaurantId, name: dto.name },
      });
      await this.audit.record({
        userId: actorId,
        action: 'department.created',
        entity: 'Department',
        entityId: dept.id,
        metadata: { name: dept.name },
      });
      return dept;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A department with this name already exists',
        );
      }
      throw err;
    }
  }

  async renameDepartment(
    restaurantId: string,
    actorId: string,
    id: string,
    dto: DepartmentDto,
  ) {
    const existing = await this.prisma.department.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Department not found');
    try {
      const dept = await this.prisma.department.update({
        where: { id },
        data: { name: dto.name },
      });
      await this.audit.record({
        userId: actorId,
        action: 'department.renamed',
        entity: 'Department',
        entityId: id,
        metadata: { from: existing.name, to: dto.name },
      });
      return dept;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A department with this name already exists',
        );
      }
      throw err;
    }
  }

  async removeDepartment(restaurantId: string, actorId: string, id: string) {
    const existing = await this.prisma.department.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Department not found');
    // users.departmentId is ON DELETE SET NULL: staff are kept, just unassigned.
    await this.prisma.department.delete({ where: { id } });
    await this.audit.record({
      userId: actorId,
      action: 'department.deleted',
      entity: 'Department',
      entityId: id,
      metadata: { name: existing.name },
    });
    return { ok: true };
  }

  // --- Per-user permission overrides ---------------------------------------

  /**
   * Replace a user's overrides. Guard rails:
   *  - you can't change your own overrides (no self-escalation or self-lockout),
   *  - the OWNER role is never overridable (can't strand the account),
   *  - you can only GRANT a permission you hold yourself (no escalation),
   *  - you can't touch a user with more access than you (#229),
   *  - unknown keys and duplicate keys are rejected, past expiries too.
   */
  async setPermissionOverrides(
    restaurantId: string,
    actor: SessionUser,
    targetId: string,
    dto: SetPermissionOverridesDto,
  ) {
    if (targetId === actor.id) {
      throw new BadRequestException(
        'You cannot change your own permission overrides',
      );
    }
    const me = await loadCeilingActor(this.prisma, actor, restaurantId);
    const target = await this.prisma.user.findFirst({
      where: { id: targetId, restaurantId },
      include: ceilingUserInclude,
    });
    if (!target) throw new NotFoundException('Staff account not found');
    if (target.role.name === 'OWNER') {
      throw new BadRequestException(
        'The owner role cannot have permission overrides',
      );
    }
    assertCanManage(me, target);

    const keys = dto.overrides.map((o) => o.permissionKey);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('Each permission can appear only once');
    }
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
    });
    const byKey = new Map(perms.map((p) => [p.key, p]));
    const now = Date.now();
    for (const o of dto.overrides) {
      if (!byKey.has(o.permissionKey)) {
        throw new BadRequestException(`Unknown permission: ${o.permissionKey}`);
      }
      // #236: `me` leaves out the actor's own time-limited grants, so
      // temporary access can never be passed on (with or without expiry).
      if (o.effect === 'GRANT' && !canGrant(me, [o.permissionKey])) {
        throw new BadRequestException(
          `You cannot grant "${o.permissionKey}" because you do not hold it yourself permanently`,
        );
      }
      if (o.expiresAt && new Date(o.expiresAt).getTime() <= now) {
        throw new BadRequestException('Expiry must be in the future');
      }
    }

    await this.prisma.$transaction([
      this.prisma.userPermissionOverride.deleteMany({
        where: { userId: targetId },
      }),
      this.prisma.userPermissionOverride.createMany({
        data: dto.overrides.map((o) => ({
          userId: targetId,
          permissionId: byKey.get(o.permissionKey)!.id,
          effect: o.effect,
          reason: o.reason || null,
          expiresAt: o.expiresAt ? new Date(o.expiresAt) : null,
        })),
      }),
    ]);

    await this.audit.record({
      userId: actor.id,
      action: 'staff.permissions_overridden',
      entity: 'User',
      entityId: targetId,
      metadata: {
        overrides: dto.overrides.map((o) => ({
          key: o.permissionKey,
          effect: o.effect,
          expiresAt: o.expiresAt ?? null,
        })),
      },
    });

    return this.prisma.user.findFirstOrThrow({
      where: { id: targetId },
      select: SELECT,
    });
  }

  /**
   * #236: editing your own record. A new password needs the current one
   * (a borrowed session must not be enough to lock you out). A non-owner may
   * not change their own active status or branches; their role is guarded
   * by `assertCanAssignRole` and their overrides by `setPermissionOverrides`.
   * Re-sending unchanged values is fine, so a full edit form still works.
   */
  private async assertSelfEditAllowed(
    me: CeilingActor,
    existing: UpdateTarget,
    dto: UpdateStaffDto,
  ) {
    if (dto.password) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          'Enter your current password to set a new one',
        );
      }
      const ok = await bcrypt.compare(
        dto.currentPassword,
        existing.passwordHash,
      );
      if (!ok) throw new ForbiddenException('Current password is incorrect');
    }
    if (isOwner(me)) return;
    if (dto.isActive !== undefined && dto.isActive !== existing.isActive) {
      throw new ForbiddenException(
        'You cannot enable or disable your own account',
      );
    }
    const myBranches = existing.branches.map((b) => b.branchId);
    if (dto.branchIds && !sameSet(dto.branchIds, myBranches)) {
      throw new ForbiddenException(
        'You cannot change your own branch assignments',
      );
    }
  }

  /**
   * #236: the last-owner check and the write it guards run in ONE
   * transaction. The active owner rows are locked (FOR UPDATE, in id order
   * so two requests cannot deadlock), so a concurrent "disable the other
   * owner" waits, then re-reads and sees the change.
   */
  private async assertAnotherActiveOwner(
    tx: Prisma.TransactionClient,
    restaurantId: string,
    id: string,
    message: string,
  ) {
    const owners = await tx.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "users" u
      JOIN "roles" r ON r."id" = u."roleId"
      WHERE u."restaurantId" = ${restaurantId}
        AND u."isActive" = true
        AND r."name" = ${OWNER_ROLE}
      ORDER BY u."id"
      FOR UPDATE OF u`;
    if (!owners.some((o) => o.id !== id)) {
      throw new BadRequestException(message);
    }
  }

  private async assertDepartmentInRestaurant(
    restaurantId: string,
    departmentId: string | null | undefined,
  ) {
    if (!departmentId) return;
    const dept = await this.prisma.department.findFirst({
      where: { id: departmentId, restaurantId },
    });
    if (!dept)
      throw new BadRequestException('Department not found for this restaurant');
  }

  private async assertRoleInRestaurant(restaurantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, restaurantId },
      include: ceilingRoleInclude,
    });
    if (!role) {
      throw new BadRequestException('Role not found for this restaurant');
    }
    return role;
  }

  private async assertBranchesInRestaurant(
    restaurantId: string,
    branchIds: string[],
  ) {
    const count = await this.prisma.branch.count({
      where: { id: { in: branchIds }, restaurantId },
    });
    if (count !== branchIds.length) {
      throw new BadRequestException('One or more branches are invalid');
    }
  }
}
