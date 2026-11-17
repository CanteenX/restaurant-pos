import type { Prisma } from '@prisma/client';

const OWNER_ROLE = 'OWNER';

/**
 * Last-owner guard (#236). Call it INSIDE the interactive transaction that
 * disables, demotes or deletes `excludeId`, before that write.
 *
 * It locks the restaurant's active owner rows (FOR UPDATE, in id order so
 * two requests can never deadlock). A concurrent request that would remove
 * another owner waits on the lock, then re-reads, so two requests can never
 * each see "someone else is still an owner" and leave nobody.
 *
 * Every path that can take an owner out of service must use this:
 * PATCH/DELETE /users/:id and DELETE /auth/me.
 */
export async function hasAnotherActiveOwner(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  restaurantId: string,
  excludeId: string,
): Promise<boolean> {
  const owners = await tx.$queryRaw<{ id: string }[]>`
    SELECT u."id" FROM "users" u
    JOIN "roles" r ON r."id" = u."roleId"
    WHERE u."restaurantId" = ${restaurantId}
      AND u."isActive" = true
      AND r."name" = ${OWNER_ROLE}
    ORDER BY u."id"
    FOR UPDATE OF u`;
  return owners.some((o) => o.id !== excludeId);
}

/**
 * Prisma's interactive-transaction options for the guarded writes: a row
 * lock can wait behind another owner's request, so allow more than the 5 s
 * default before giving up (the reviewer's P2028 note).
 */
export const LAST_OWNER_TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };
