import { PrismaClient } from '@prisma/client';

/**
 * The sync suites each reconfigure the single sync_state row (role, keys,
 * cursors). Jest runs e2e files in parallel, so they take this session
 * advisory lock for their whole run. Returns the release function.
 */
export async function lockSyncState(): Promise<() => Promise<void>> {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '1');
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_lock(hashtext('nventra-sync-e2e-state'))`,
  );
  return async () => {
    await db.$executeRawUnsafe('SELECT pg_advisory_unlock_all()');
    await db.$disconnect();
  };
}
