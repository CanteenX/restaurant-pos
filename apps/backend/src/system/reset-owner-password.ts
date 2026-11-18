import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { z } from 'zod';

// Owner password recovery from the server's shell (#236 review). This is for
// the sole owner who forgot their password: nobody else may reset an owner,
// and self-service changes need the current password. Running it needs shell
// access to the server, which is the trust boundary of a self-hosted install.
// Email reset (#224) will be the in-app path. See docs/SUPPORT-RUNBOOK.md §4.

const MIN_PASSWORD = 8;
const BCRYPT_COST = 12;

export interface ResetArgs {
  email: string;
  restaurantId?: string;
}

const argsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  restaurantId: z.string().trim().min(1).optional(),
});

/** Reads `--email <e>` / `--email=<e>` and optional `--restaurant <id>`. */
export function parseResetArgs(argv: readonly string[]): ResetArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (flag !== '--email' && flag !== '--restaurant') continue;
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i++;
    if (value !== undefined) values.set(flag, value);
  }
  const parsed = argsSchema.safeParse({
    email: values.get('--email'),
    restaurantId: values.get('--restaurant'),
  });
  if (!parsed.success) {
    throw new Error(
      'Usage: reset-owner-password --email <owner email> [--restaurant <id>]',
    );
  }
  const { email, restaurantId } = parsed.data;
  return restaurantId ? { email, restaurantId } : { email };
}

/** A random password to hand to the owner (they should change it). */
export function generatePassword(): string {
  return randomBytes(15).toString('base64url');
}

type Db = Pick<PrismaClient, 'user' | 'auditLog'>;

/**
 * Sets a new password on the OWNER account with this email, ends all of its
 * sessions (tokenVersion + 1) and writes an audit entry (never the password).
 */
export async function resetOwnerPassword(
  prisma: Db,
  opts: ResetArgs & { newPassword: string },
): Promise<{ userId: string; restaurantId: string; isActive: boolean }> {
  if (opts.newPassword.length < MIN_PASSWORD) {
    throw new Error(`The password must be at least ${MIN_PASSWORD} characters`);
  }
  const matches = await prisma.user.findMany({
    where: {
      email: { equals: opts.email, mode: 'insensitive' },
      ...(opts.restaurantId ? { restaurantId: opts.restaurantId } : {}),
    },
    include: { role: true },
  });
  if (matches.length === 0) {
    throw new Error(`No account with email ${opts.email}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${opts.email} exists in ${matches.length} restaurants; add --restaurant <id> (one of: ${matches.map((m) => m.restaurantId).join(', ')})`,
    );
  }
  const [user] = matches;
  if (user.role.name !== 'OWNER') {
    throw new Error(
      `${opts.email} is not an owner. Staff passwords are reset by an owner in Settings > Staff.`,
    );
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(opts.newPassword, BCRYPT_COST),
      tokenVersion: { increment: 1 },
    },
  });
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: 'owner.password_reset_cli',
      entity: 'User',
      entityId: user.id,
      metadata: { via: 'server shell' },
    },
  });
  return {
    userId: user.id,
    restaurantId: user.restaurantId,
    isActive: user.isActive,
  };
}
