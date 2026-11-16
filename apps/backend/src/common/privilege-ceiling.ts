import { ForbiddenException } from '@nestjs/common';
import { permissionSatisfied } from '@nventra/types';

/**
 * Privilege ceiling (#229). Nobody may create, edit, assign, delete or reset
 * an account or role that holds more access than they do, and only an OWNER
 * may touch an OWNER. Without this, someone holding just "manage staff" could
 * promote themselves to OWNER, reset the owner's password or 2FA, or build a
 * custom role with every permission. The OWNER keeps full power.
 *
 * Every user/role mutation path calls one of the asserts below.
 */

export const OWNER_ROLE = 'OWNER';

/** The acting user: a `SessionUser` (cookie session or staff API key). */
export interface CeilingActor {
  id: string;
  roleName: string;
  permissions: readonly string[];
}

export interface CeilingRole {
  name: string;
  permissions: readonly { permission: { key: string } }[];
}

export interface CeilingOverride {
  effect: string; // 'GRANT' | 'DENY'
  expiresAt: Date | null;
  permission: { key: string };
}

/** A staff account: its role plus any per-user overrides. */
export interface CeilingUser {
  id: string;
  role: CeilingRole;
  permissionOverrides?: readonly CeilingOverride[];
}

/**
 * Prisma `include` that loads what `assertCanManage` needs (same shape as
 * `permissionInclude` in auth/effective-permissions.ts).
 */
export { permissionInclude as ceilingUserInclude } from '../auth/effective-permissions';

/** Prisma `include` that loads exactly what `assertCanManageRole` needs. */
export const ceilingRoleInclude = {
  permissions: { include: { permission: true } },
} as const;

const MANAGE_DENIED =
  'You cannot manage an account or role that has more access than your own.';
const OWNER_DENIED =
  'Only an owner can manage an owner account or the Owner role.';
const SELF_ROLE_DENIED = 'You cannot change your own role.';

export function isOwner(actor: CeilingActor): boolean {
  return actor.roleName === OWNER_ROLE;
}

/**
 * The most a user could hold: role permissions plus live GRANT overrides.
 * DENY overrides are deliberately NOT subtracted: whoever manages this user
 * could lift the DENY, so the ceiling must already cover it.
 */
export function ceilingKeys(user: CeilingUser, now = Date.now()): Set<string> {
  const keys = new Set(user.role.permissions.map((p) => p.permission.key));
  for (const o of user.permissionOverrides ?? []) {
    const live = !o.expiresAt || o.expiresAt.getTime() > now;
    if (o.effect === 'GRANT' && live) keys.add(o.permission.key);
  }
  return keys;
}

function missingKeys(actor: CeilingActor, keys: Iterable<string>): string[] {
  return [...keys].filter((k) => !permissionSatisfied(actor.permissions, k));
}

export function canGrant(actor: CeilingActor, keys: Iterable<string>): boolean {
  return isOwner(actor) || missingKeys(actor, keys).length === 0;
}

export function canManageRole(actor: CeilingActor, role: CeilingRole): boolean {
  if (isOwner(actor)) return true;
  if (role.name === OWNER_ROLE) return false;
  return canGrant(
    actor,
    role.permissions.map((p) => p.permission.key),
  );
}

export function canManage(actor: CeilingActor, target: CeilingUser): boolean {
  if (isOwner(actor)) return true;
  if (target.role.name === OWNER_ROLE) return false;
  return canGrant(actor, ceilingKeys(target));
}

/** Throws 403 unless the actor holds every one of `keys`. */
export function assertCanGrant(
  actor: CeilingActor,
  keys: Iterable<string>,
): void {
  if (isOwner(actor)) return;
  const missing = missingKeys(actor, keys);
  if (missing.length > 0) {
    throw new ForbiddenException(
      `You can only grant permissions you hold yourself (missing: ${missing.join(', ')}).`,
    );
  }
}

/** Throws 403 unless the role is OWNER-free and within the actor's access. */
export function assertCanManageRole(
  actor: CeilingActor,
  role: CeilingRole,
): void {
  if (isOwner(actor)) return;
  if (role.name === OWNER_ROLE) throw new ForbiddenException(OWNER_DENIED);
  if (!canManageRole(actor, role)) throw new ForbiddenException(MANAGE_DENIED);
}

/** Throws 403 unless the actor may edit, delete or reset `target`. */
export function assertCanManage(
  actor: CeilingActor,
  target: CeilingUser,
): void {
  if (isOwner(actor)) return;
  if (target.role.name === OWNER_ROLE) {
    throw new ForbiddenException(OWNER_DENIED);
  }
  if (!canManage(actor, target)) throw new ForbiddenException(MANAGE_DENIED);
}

/**
 * Throws 403 unless the actor may put `targetId` on `role`. A non-owner can
 * never change their own role, so self-escalation is impossible.
 */
export function assertCanAssignRole(
  actor: CeilingActor,
  targetId: string,
  role: CeilingRole,
): void {
  if (isOwner(actor)) return;
  if (targetId === actor.id) throw new ForbiddenException(SELF_ROLE_DENIED);
  assertCanManageRole(actor, role);
}
