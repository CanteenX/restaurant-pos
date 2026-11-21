import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { installCapture } from '../sync/capture-install';
import { prismaConnector, upgradeDbIdentity } from './db-identity-upgrade';
import {
  checkRuntime,
  grantDataAccess,
  OWNER,
  prepareOwner,
  randomPassword,
  roleUrl,
  RUNTIME,
} from './db-runtime';

function runtimePassword(file: string): string {
  let saved: string;
  try {
    saved = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return randomPassword();
    throw e;
  }
  const url = new URL(saved);
  if (url.username !== RUNTIME || !/^[a-f0-9]{64}$/.test(url.password))
    throw new Error('Invalid saved runtime database identity');
  return url.password;
}

async function setup(bootstrapUrl: string, file: string) {
  process.stdout.write('Checking the stock database identity\n');
  const identity = await upgradeDbIdentity({
    url: bootstrapUrl,
    connectAs: prismaConnector(bootstrapUrl),
  });
  if (identity === 'skipped' || identity === 'unavailable')
    throw new Error('Stock database identity is unavailable');

  const adminUrl = new URL(bootstrapUrl);
  adminUrl.searchParams.set('connection_limit', '1');
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await admin.$executeRawUnsafe(
      `SELECT pg_advisory_lock(hashtext('nventra_db_runtime'))`,
    );
    const password = runtimePassword(file);
    const ownerPassword = randomPassword();
    process.stdout.write('Preparing the database schema owner\n');
    await prepareOwner(admin, ownerPassword);
    const ownerUrl = roleUrl(bootstrapUrl, OWNER, ownerPassword);
    try {
      process.stdout.write(
        'Applying migrations and sync capture definitions\n',
      );
      execFileSync(
        process.execPath,
        [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            DATABASE_URL: ownerUrl,
            DATABASE_BOOTSTRAP_URL: undefined,
            POSTGRES_PASSWORD: undefined,
          },
        },
      );
      const owner = new PrismaClient({ datasourceUrl: ownerUrl });
      try {
        await installCapture(owner, RUNTIME);
      } finally {
        await owner.$disconnect();
      }
      process.stdout.write(
        'Provisioning the database runtime and restore logins\n',
      );
      await grantDataAccess(admin, password);
    } finally {
      await admin.$executeRawUnsafe(
        `ALTER ROLE ${OWNER} NOLOGIN PASSWORD NULL`,
      );
    }
    const url = roleUrl(bootstrapUrl, RUNTIME, password);
    await checkRuntime(url);
    writeFileSync(`${file}.tmp`, `${url}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } finally {
    await admin.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === 'check') {
    await checkRuntime(process.env.DATABASE_URL ?? '');
    return;
  }
  const file = process.env.NVENTRA_DATABASE_URL_FILE;
  const explicitUrl = process.env.DATABASE_BOOTSTRAP_URL;
  const password = process.env.POSTGRES_PASSWORD;
  const host = process.env.NVENTRA_DB_HOST;
  const url =
    explicitUrl ??
    (host && password
      ? roleUrl(`postgresql://${host}:5432/nventra_pos`, 'nventra', password)
      : undefined);
  if (!url || !file)
    throw new Error('Missing managed database setup configuration');
  await setup(url, file);
}

main().catch(() => {
  // Prisma and child-process errors can contain connection details or SQL.
  process.stderr.write(
    'Managed database setup/check failed. Verify the database is reachable, the stock bootstrap credentials are correct, and migrations are healthy.\n',
  );
  process.exitCode = 1;
});
