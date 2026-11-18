// Pre-rename install upgrade (#143) against a real Postgres: a legacy
// nodedr / nodedr_restaurant superuser + database holding data is renamed to
// nventra / nventra_pos by the same code the container runs at start, with the
// data, ownership and password intact; a second run is a no-op.
//
// Roles are cluster-wide, so this only runs on a cluster that has neither role
// yet (CI's throwaway Postgres). On a dev cluster that already has them it
// skips instead of touching them. DATABASE_URL must be a superuser.
import { PrismaClient } from '@prisma/client';
import {
  CURRENT_IDENTITY as NEW,
  LEGACY_IDENTITY as OLD,
  UPGRADE_ROLE,
  prismaConnector,
  quoteLiteral,
  upgradeDbIdentity,
  withIdentity,
} from './../src/system/db-identity-upgrade';

const BASE = process.env.DATABASE_URL ?? '';
const PASSWORD = "p@ss:w'rd%/x";

function urlFor(user: string, database: string, password = PASSWORD) {
  const u = new URL(withIdentity(BASE, user, database));
  u.password = encodeURIComponent(password);
  u.searchParams.delete('schema');
  return u.toString();
}

async function as<T>(url: string, fn: (db: PrismaClient) => Promise<T>) {
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

const admin = new PrismaClient();
const run = (url = urlFor(NEW.user, NEW.database)) =>
  upgradeDbIdentity({ url, connectAs: prismaConnector(url) });

let enabled = false;

async function names(sql: string): Promise<string[]> {
  const rows = await admin.$queryRawUnsafe<{ n: string }[]>(sql);
  return rows.map((r) => r.n);
}
const roles = () =>
  names(
    `SELECT rolname AS n FROM pg_roles WHERE rolname IN ('${OLD.user}','${NEW.user}','${UPGRADE_ROLE}') ORDER BY 1`,
  );
const databases = () =>
  names(
    `SELECT datname AS n FROM pg_database WHERE datname IN ('${OLD.database}','${NEW.database}') ORDER BY 1`,
  );

async function cleanup() {
  for (const d of [OLD.database, NEW.database]) {
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${d}'`,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${d}"`);
  }
  for (const r of [UPGRADE_ROLE, OLD.user, NEW.user]) {
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${r}"`);
  }
}

beforeAll(async () => {
  enabled = (await roles()).length === 0 && (await databases()).length === 0;
  if (!enabled) {
    process.stderr.write(
      'db-identity-upgrade e2e skipped: nodedr/nventra already exist on this cluster\n',
    );
    return;
  }
  // What an old install's volume holds: the legacy superuser owning the data.
  await admin.$executeRawUnsafe(
    `CREATE ROLE "${OLD.user}" LOGIN SUPERUSER PASSWORD ${quoteLiteral(PASSWORD)}`,
  );
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${OLD.database}" OWNER "${OLD.user}"`,
  );
  await as(urlFor(OLD.user, OLD.database), async (db) => {
    await db.$executeRawUnsafe('CREATE TABLE marker (note text)');
    await db.$executeRawUnsafe(`INSERT INTO marker VALUES ('kept')`);
  });
});

afterAll(async () => {
  if (enabled) await cleanup();
  await admin.$disconnect();
});

describe('database identity upgrade (real Postgres)', () => {
  it('leaves the legacy install alone for a non-stock DATABASE_URL', async () => {
    if (!enabled) return;
    await expect(run(urlFor('someone', 'else'))).resolves.toBe('skipped');
    expect(await roles()).toEqual([OLD.user]);
  });

  it('reports unavailable with the wrong password and changes nothing', async () => {
    if (!enabled) return;
    const wrong = urlFor(NEW.user, NEW.database, 'not-the-password');
    await expect(run(wrong)).resolves.toBe('unavailable');
    expect(await roles()).toEqual([OLD.user]);
    expect(await databases()).toEqual([OLD.database]);
  });

  it('renames role and database, keeping data, ownership and password', async () => {
    if (!enabled) return;
    await expect(run()).resolves.toBe('upgraded');
    expect(await roles()).toEqual([NEW.user]);
    expect(await databases()).toEqual([NEW.database]);
    const rows = await as(urlFor(NEW.user, NEW.database), (db) =>
      db.$queryRawUnsafe<{ note: string; owner: string }[]>(
        `SELECT note, (SELECT tableowner FROM pg_tables WHERE tablename = 'marker') AS owner FROM marker`,
      ),
    );
    expect(rows).toEqual([{ note: 'kept', owner: NEW.user }]);
  });

  it('is a no-op on the second run', async () => {
    if (!enabled) return;
    await expect(run()).resolves.toBe('current');
    expect(await roles()).toEqual([NEW.user]);
  });
});
