import { z } from 'zod';
import { controlChallengeSchema } from './control-auth';
import { CONTROL_PERMISSIONS, type ControlPermissionKey } from './permissions';

const permission = z.enum(CONTROL_PERMISSIONS);
const uniquePermissions = z.array(permission).max(CONTROL_PERMISSIONS.length)
  .refine((keys) => new Set(keys).size === keys.length);

/** Roles are database rows; these schemas only validate the request shape and the permission vocabulary. */
export const controlRoleKey = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const controlRoleCreate = z.strictObject({
  key: controlRoleKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  grants: uniquePermissions,
});
export const controlRoleUpdate = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  grants: uniquePermissions.optional(),
}).refine((body) => Object.keys(body).length > 0);
export const controlStaffRoleAssignment = z.strictObject({
  roleId: z.uuid().toLowerCase(),
  extraGrants: uniquePermissions.default([]),
  removedGrants: uniquePermissions.default([]),
});

export const controlStaffInvite = controlStaffRoleAssignment.extend({ email: controlChallengeSchema.shape.email });
export const controlStaffInviteAcceptance = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  token: controlChallengeSchema.shape.enrollmentProof.unwrap(),
  password: controlChallengeSchema.shape.password.refine((password) => [...password].length >= 12),
});

/** Effective grants are the role's grants plus the person's extras minus removals, in vocabulary order. */
export function effectiveControlGrants(role: readonly string[], extra: readonly string[], removed: readonly string[]): ControlPermissionKey[] {
  const held = new Set([...role, ...extra]);
  for (const key of removed) held.delete(key);
  return CONTROL_PERMISSIONS.filter((key) => held.has(key));
}

/** The minimal per-person tweaks that turn a role's grants into the requested grants. */
export function controlGrantTweaks(role: readonly string[], wanted: readonly string[]) {
  const roleSet = new Set(role), wantedSet = new Set(wanted);
  return {
    extraGrants: CONTROL_PERMISSIONS.filter((key) => wantedSet.has(key) && !roleSet.has(key)),
    removedGrants: CONTROL_PERMISSIONS.filter((key) => roleSet.has(key) && !wantedSet.has(key)),
  };
}
