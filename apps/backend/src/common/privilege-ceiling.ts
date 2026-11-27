import { ForbiddenException } from '@nestjs/common';
import { PERMISSION_IMPLIES, permissionSatisfied } from '@nventra/types';
import type { PrismaClient } from '@prisma/client';
import { permissionInclude } from '../auth/effective-permissions';

/**
 * Privilege ceiling (#229). Nobody may create, edit, assign, delete or reset
 * an account or role that holds more access than they do, and only an OWNER
 * may touch an OWNER. Without this, someone holding just "manage staff" could
 * promote themselves to OWNER, reset the owner's password or 2FA, or build a
 * custom role with every permission. The OWNER keeps full power.
 *
 * #236: the actor's side of every check is `grantableKeys`, which leaves out
 * permissions held only through a time-limited GRANT, so temporary access can
 * never be turned into a permanent role or override. Credential resets
 * (password, 2FA, sign-out-everywhere) need strictly more access than the
 * target, not just equal access.
 *
 * Every user/role mutation path calls one of the asserts below with an actor
 * built by `loadCeilingActor`.
 */

export const OWNER_ROLE = 'OWNER';

/** The acting user, as built by `loadCeilingActor`. */
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
  'You cannot manage an account or role that has more access than your own';
const OWNER_DENIED =
  'Only an owner can manage an owner account or the Owner role.';
const SELF_ROLE_DENIED = 'You cannot change your own role.';
const RESET_DENIED =
  'You can only reset the password, 2FA or sessions of someone with less access than you.';
const ACTOR_DENIED = 'Your account is not active in this restaurant.';

const isLive = (o: CeilingOverride, now: number): boolean =>
  !o.expiresAt || o.expiresAt.getTime() > now;

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
    if (o.effect === 'GRANT' && isLive(o, now)) keys.add(o.permission.key);
  }
  return keys;
}

/**
 * What a user may hand on to others (#236): role permissions plus GRANTs
 * that never expire, minus live DENYs. A permission held only through a
 * time-limited GRANT is left out, so it can never outlive its expiry by
 * being copied into a role or into someone else's override.
 */
export function grantableKeys(user: CeilingUser, now = Date.now()): string[] {
  const keys = new Set(user.role.permissions.map((p) => p.permission.key));
  const live = (user.permissionOverrides ?? []).filter((o) => isLive(o, now));
  for (const o of live) {
    if (o.effect === 'GRANT' && !o.expiresAt) keys.add(o.permission.key);
  }
  for (const o of live) if (o.effect === 'DENY') keys.delete(o.permission.key);
  // A denied implied permission must not be delegated via its parent grant.
  for (const o of live) {
    if (
      o.effect === 'DENY' &&
      permissionSatisfied([...keys], o.permission.key)
    ) {
      keys.add(`!${o.permission.key}`);
    }
  }
  return [...keys];
}

/**
 * Re-reads the acting user and returns them as a ceiling actor whose
 * permissions are their `grantableKeys`. Refuses a missing or disabled actor.
 */
export async function loadCeilingActor(
  prisma: Pick<PrismaClient, 'user'>,
  actor: { id: string },
  restaurantId: string,
): Promise<CeilingActor> {
  const row = await prisma.user.findFirst({
    where: { id: actor.id, restaurantId },
    include: permissionInclude,
  });
  if (!row || !row.isActive) throw new ForbiddenException(ACTOR_DENIED);
  return {
    id: row.id,
    roleName: row.role.name,
    permissions: grantableKeys(row),
  };
}

function missingKeys(actor: CeilingActor, keys: Iterable<string>): string[] {
  const required = new Set(keys);
  // Granting or managing a parent also confers every implied permission.
  for (const key of required) {
    if (!Object.hasOwn(PERMISSION_IMPLIES, key)) continue;
    for (const implied of PERMISSION_IMPLIES[
      key as keyof typeof PERMISSION_IMPLIES
    ] ?? []) {
      required.add(implied);
    }
  }
  return [...required].filter(
    (k) => !permissionSatisfied(actor.permissions, k),
  );
}

/** "<reason> (missing: a, b)." — only permission keys, nothing internal. */
function deniedWithKeys(reason: string, missing: string[]): ForbiddenException {
  return new ForbiddenException(`${reason} (missing: ${missing.join(', ')}).`);
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
    throw deniedWithKeys(
      'You can only grant permissions you hold yourself, permanently',
      missing,
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
  const missing = missingKeys(
    actor,
    role.permissions.map((p) => p.permission.key),
  );
  if (missing.length > 0) throw deniedWithKeys(MANAGE_DENIED, missing);
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
  const missing = missingKeys(actor, ceilingKeys(target));
  if (missing.length > 0) throw deniedWithKeys(MANAGE_DENIED, missing);
}

/**
 * Throws 403 unless the actor may reset `target`'s credentials (password,
 * 2FA, sessions). That needs strictly more access than the target: equal is
 * not enough, or two admins could take over each other's accounts. The
 * OWNER may reset anyone.
 */
export function assertCanResetCredentials(
  actor: CeilingActor,
  target: CeilingUser,
): void {
  if (isOwner(actor)) return;
  assertCanManage(actor, target);
  const targetKeys = [...ceilingKeys(target)];
  const above = actor.permissions.some(
    (k) => !k.startsWith('!') && !permissionSatisfied(targetKeys, k),
  );
  if (!above) throw new ForbiddenException(RESET_DENIED);
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
