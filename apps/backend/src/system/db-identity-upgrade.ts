// One-off, idempotent upgrade of the Postgres identity for installs made
// before the Nventra rename (#143).
//
// The compose files now create the role `nventra` and database `nventra_pos`,
// but Postgres only applies POSTGRES_USER/POSTGRES_DB when its data directory
// is first created. An existing volume still holds `nodedr` /
// `nodedr_restaurant`, so the new DATABASE_URL cannot log in. The backend
// container runs this before `prisma migrate deploy`: when the new identity
// cannot log in but the legacy one (same password) can, it renames the role
// and the database in place. Data, ownership and grants are untouched.
//
// A session cannot rename its own role, so the legacy role first creates a
// short-lived helper superuser (same password as the install), the helper
// does the renames, and the renamed role drops the helper. Every step checks
// the current state first, so a run that dies half-way resumes on the next
// container start.
import { PrismaClient } from '@prisma/client';

export interface DbIdentity {
  user: string;
  database: string;
}

export const LEGACY_IDENTITY: DbIdentity = {
  user: 'nodedr',
  database: 'nodedr_restaurant',
};
export const CURRENT_IDENTITY: DbIdentity = {
  user: 'nventra',
  database: 'nventra_pos',
};
// Legacy updater versions copy the old image command, including its identity
// CLI and direct Nest startup. Both must reject the old managed credentials.
export function refuseLegacyStockRuntime(value: string | undefined): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid database connection configuration');
  }
  const stockHosts = [
    'postgres',
    'nventra-pos-postgres',
    'nodedr-restaurant-pos-postgres',
  ];
  if (
    stockHosts.includes(url.hostname) &&
    [CURRENT_IDENTITY, LEGACY_IDENTITY].some(
      ({ user, database }) =>
        url.username === user && url.pathname === `/${database}`,
    )
  ) {
    throw new Error(
      'Stock database configuration detected. Apply the current Compose or CasaOS definition before starting this image.',
    );
  }
}
export const UPGRADE_ROLE = 'nventra_identity_upgrade';
/**
 * docker-compose.yml's POSTGRES_PASSWORD default changed with the rename, so
 * an install that never set one has the old default on its volume.
 */
export const DEV_DEFAULT_PASSWORD = {
  current: 'nventra_dev_pw',
  legacy: 'nodedr_dev_pw',
};
/** Always present (created by initdb); renames run from here. */
const MAINTENANCE_DB = 'postgres';

/** The SQL the upgrade needs, run as whichever role `connectAs` logged in as. */
export interface PgAdmin {
  roleExists(name: string): Promise<boolean>;
  databaseExists(name: string): Promise<boolean>;
  /** Creates the role as a LOGIN SUPERUSER, or resets it if it exists. */
  createLoginSuperuser(name: string, password: string): Promise<void>;
  renameRole(from: string, to: string): Promise<void>;
  setPassword(role: string, password: string): Promise<void>;
  /** Disconnects other sessions on `from`, then renames it. */
  renameDatabase(from: string, to: string): Promise<void>;
  dropRole(name: string): Promise<void>;
  close(): Promise<void>;
}

/** Logs in as `user` to `database`; null if the login is refused. */
export type ConnectAs = (
  user: string,
  database: string,
  password: string,
) => Promise<PgAdmin | null>;

export type UpgradeResult =
  /** DATABASE_URL is not the stock nventra identity: not ours to touch. */
  | 'skipped'
  /** Already on the new identity (fresh install, or upgraded earlier). */
  | 'current'
  /** Renamed from the legacy identity in this run. */
  | 'upgraded'
  /** Neither identity could log in; `prisma migrate deploy` reports why. */
  | 'unavailable';

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Standard-conforming string literal (no backslash escapes, PG >= 9.1). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('NUL byte in SQL literal');
  return `'${value.replace(/'/g, "''")}'`;
}

/** Same URL (password, host, port, query) with another user and database. */
export function withIdentity(
  url: string,
  user: string,
  database: string,
): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function identityOf(url: string): DbIdentity & { password: string } {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    password: decodeURIComponent(u.password),
  };
}

async function using<T>(
  admin: PgAdmin,
  fn: (a: PgAdmin) => Promise<T>,
): Promise<T> {
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

/** Already logged in as the new role: finish a half-done run, if any. */
async function finishAsCurrent(admin: PgAdmin): Promise<UpgradeResult> {
  let result: UpgradeResult = 'current';
  if (
    !(await admin.databaseExists(CURRENT_IDENTITY.database)) &&
    (await admin.databaseExists(LEGACY_IDENTITY.database))
  ) {
    await admin.renameDatabase(
      LEGACY_IDENTITY.database,
      CURRENT_IDENTITY.database,
    );
    result = 'upgraded';
  }
  if (await admin.roleExists(UPGRADE_ROLE)) await admin.dropRole(UPGRADE_ROLE);
  return result;
}

/** As the helper superuser: rename role + database to the new identity. */
async function renameAsHelper(admin: PgAdmin, password: string) {
  if (await admin.roleExists(LEGACY_IDENTITY.user)) {
    if (await admin.roleExists(CURRENT_IDENTITY.user)) {
      throw new Error(
        `both roles "${LEGACY_IDENTITY.user}" and "${CURRENT_IDENTITY.user}" exist; resolve by hand`,
      );
    }
    await admin.renameRole(LEGACY_IDENTITY.user, CURRENT_IDENTITY.user);
  }
  // Renaming clears an md5 password (the name is its salt); set it again.
  await admin.setPassword(CURRENT_IDENTITY.user, password);
  if (
    !(await admin.databaseExists(CURRENT_IDENTITY.database)) &&
    (await admin.databaseExists(LEGACY_IDENTITY.database))
  ) {
    await admin.renameDatabase(
      LEGACY_IDENTITY.database,
      CURRENT_IDENTITY.database,
    );
  }
}

/** The legacy role, with the install's password or the old dev default. */
async function connectAsLegacy(
  connectAs: (user: string, password?: string) => Promise<PgAdmin | null>,
  password: string,
) {
  const legacy = await connectAs(LEGACY_IDENTITY.user);
  if (legacy || password !== DEV_DEFAULT_PASSWORD.current) return legacy;
  return connectAs(LEGACY_IDENTITY.user, DEV_DEFAULT_PASSWORD.legacy);
}

export async function upgradeDbIdentity(opts: {
  url: string;
  connectAs: ConnectAs;
}): Promise<UpgradeResult> {
  const target = identityOf(opts.url);
  const connectAs = (user: string, password = target.password) =>
    opts.connectAs(user, MAINTENANCE_DB, password);
  if (
    target.user !== CURRENT_IDENTITY.user ||
    target.database !== CURRENT_IDENTITY.database
  ) {
    return 'skipped';
  }

  const current = await connectAs(CURRENT_IDENTITY.user);
  if (current) return using(current, finishAsCurrent);

  let helper = await connectAs(UPGRADE_ROLE);
  if (!helper) {
    const legacy = await connectAsLegacy(connectAs, target.password);
    if (!legacy) return 'unavailable';
    await using(legacy, async (a) => {
      if (await a.roleExists(CURRENT_IDENTITY.user)) {
        throw new Error(
          `role "${CURRENT_IDENTITY.user}" already exists but DATABASE_URL's password does not log in to it; resolve by hand`,
        );
      }
      await a.createLoginSuperuser(UPGRADE_ROLE, target.password);
    });
    helper = await connectAs(UPGRADE_ROLE);
    if (!helper) throw new Error(`could not log in as ${UPGRADE_ROLE}`);
  }
  await using(helper, (a) => renameAsHelper(a, target.password));

  const renamed = await connectAs(CURRENT_IDENTITY.user);
  if (!renamed) throw new Error(`could not log in as ${CURRENT_IDENTITY.user}`);
  await using(renamed, finishAsCurrent);
  return 'upgraded';
}

/** Prisma error codes for "these credentials / this database don't work". */
const LOGIN_REFUSED = new Set(['P1000', 'P1003']);

class PrismaPgAdmin implements PgAdmin {
  constructor(private readonly db: PrismaClient) {}

  private async exists(sql: string, name: string) {
    const rows = await this.db.$queryRawUnsafe<unknown[]>(sql, name);
    return rows.length > 0;
  }
  roleExists(name: string) {
    return this.exists('SELECT 1 FROM pg_roles WHERE rolname = $1', name);
  }
  databaseExists(name: string) {
    return this.exists('SELECT 1 FROM pg_database WHERE datname = $1', name);
  }
  async createLoginSuperuser(name: string, password: string) {
    const verb = (await this.roleExists(name)) ? 'ALTER' : 'CREATE';
    await this.db.$executeRawUnsafe(
      `${verb} ROLE ${quoteIdent(name)} WITH LOGIN SUPERUSER PASSWORD ${quoteLiteral(password)}`,
    );
  }
  async renameRole(from: string, to: string) {
    await this.db.$executeRawUnsafe(
      `ALTER ROLE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`,
    );
  }
  async setPassword(role: string, password: string) {
    await this.db.$executeRawUnsafe(
      `ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
    );
  }
  async renameDatabase(from: string, to: string) {
    await this.db.$queryRawUnsafe(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      from,
    );
    await this.db.$executeRawUnsafe(
      `ALTER DATABASE ${quoteIdent(from)} RENAME TO ${quoteIdent(to)}`,
    );
  }
  async dropRole(name: string) {
    await this.db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${quoteIdent(name)}`);
  }
  close() {
    return this.db.$disconnect();
  }
}

/** Real `ConnectAs` over Prisma, reusing everything else from `url`. */
export function prismaConnector(url: string): ConnectAs {
  return async (user, database, password) => {
    const u = new URL(withIdentity(url, user, database));
    u.password = encodeURIComponent(password);
    u.searchParams.delete('schema');
    u.searchParams.set('connection_limit', '1');
    const db = new PrismaClient({ datasourceUrl: u.toString() });
    try {
      await db.$connect();
    } catch (e) {
      await db.$disconnect().catch(() => undefined);
      const code = (e as { errorCode?: string }).errorCode;
      if (code && LOGIN_REFUSED.has(code)) return null;
      throw e;
    }
    return new PrismaPgAdmin(db);
  };
}
