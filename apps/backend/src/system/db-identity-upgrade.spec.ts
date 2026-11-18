import {
  CURRENT_IDENTITY,
  LEGACY_IDENTITY,
  UPGRADE_ROLE,
  type PgAdmin,
  quoteIdent,
  quoteLiteral,
  upgradeDbIdentity,
  withIdentity,
} from './db-identity-upgrade';

const PW = 's3cr%t';
const URL_NEW = `postgresql://nventra:${encodeURIComponent(PW)}@postgres:5432/nventra_pos?schema=public`;

/** In-memory model of a Postgres cluster: roles (name -> password) and databases. */
class FakeCluster {
  roles = new Map<string, string | null>();
  dbs = new Set<string>();
  calls: string[] = [];
  failOn?: string;

  connectAs = (
    user: string,
    database: string,
    password: string,
  ): Promise<PgAdmin | null> => {
    const ok =
      this.roles.has(user) &&
      this.roles.get(user) === password &&
      this.dbs.has(database);
    if (!ok) return Promise.resolve(null);
    const step = (name: string, fn: () => void) => {
      if (this.failOn === name) throw new Error(`boom at ${name}`);
      this.calls.push(`${user}:${name}`);
      fn();
      return Promise.resolve();
    };
    return Promise.resolve({
      roleExists: (n) => Promise.resolve(this.roles.has(n)),
      databaseExists: (n) => Promise.resolve(this.dbs.has(n)),
      createLoginSuperuser: (n, pw) =>
        step('create', () => this.roles.set(n, pw)),
      renameRole: (from, to) =>
        step('renameRole', () => {
          if (from === user) throw new Error('session user cannot be renamed');
          // md5-hashed passwords are cleared by a rename; model the worst case.
          this.roles.delete(from);
          this.roles.set(to, null);
        }),
      setPassword: (n, pw) => step('setPassword', () => this.roles.set(n, pw)),
      renameDatabase: (from, to) =>
        step('renameDb', () => {
          this.dbs.delete(from);
          this.dbs.add(to);
        }),
      dropRole: (n) =>
        step('dropRole', () => {
          if (n === user) throw new Error('current user cannot be dropped');
          this.roles.delete(n);
        }),
      close: () => Promise.resolve(),
    });
  };

  static legacy(password = PW) {
    const c = new FakeCluster();
    c.roles.set(LEGACY_IDENTITY.user, password);
    c.dbs.add('postgres');
    c.dbs.add(LEGACY_IDENTITY.database);
    return c;
  }
}

const run = (c: FakeCluster, url = URL_NEW) =>
  upgradeDbIdentity({ url, connectAs: c.connectAs });

function expectUpgraded(c: FakeCluster, password = PW) {
  expect([...c.roles.entries()]).toEqual([[CURRENT_IDENTITY.user, password]]);
  expect(c.dbs.has(CURRENT_IDENTITY.database)).toBe(true);
  expect(c.dbs.has(LEGACY_IDENTITY.database)).toBe(false);
}

describe('withIdentity', () => {
  it('swaps user and database, keeps password, host, port and query', () => {
    expect(withIdentity(URL_NEW, 'nodedr', 'postgres')).toBe(
      'postgresql://nodedr:s3cr%25t@postgres:5432/postgres?schema=public',
    );
  });
});

describe('quoting', () => {
  it('doubles quotes in identifiers and literals', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(() => quoteLiteral('a\0b')).toThrow();
  });
});

describe('upgradeDbIdentity', () => {
  it('renames a legacy nodedr/nodedr_restaurant install to nventra/nventra_pos', async () => {
    const c = FakeCluster.legacy();
    await expect(run(c)).resolves.toBe('upgraded');
    expectUpgraded(c);
    // The helper role does the renames: the session user can't rename itself.
    expect(c.calls).toEqual([
      'nodedr:create',
      `${UPGRADE_ROLE}:renameRole`,
      `${UPGRADE_ROLE}:setPassword`,
      `${UPGRADE_ROLE}:renameDb`,
      'nventra:dropRole',
    ]);
  });

  it('is a no-op on a current install and when run twice', async () => {
    const c = FakeCluster.legacy();
    await run(c);
    c.calls = [];
    await expect(run(c)).resolves.toBe('current');
    expect(c.calls).toEqual([]);
    expectUpgraded(c);
  });

  it('skips a DATABASE_URL that is not the stock nventra identity', async () => {
    const c = FakeCluster.legacy();
    const custom = withIdentity(URL_NEW, 'me', 'mydb');
    await expect(run(c, custom)).resolves.toBe('skipped');
    expect(c.calls).toEqual([]);
  });

  it('upgrades a no-.env dev install from the old default password to the new one', async () => {
    const c = FakeCluster.legacy('nodedr_dev_pw');
    const dev = 'postgresql://nventra:nventra_dev_pw@postgres:5432/nventra_pos';
    await expect(run(c, dev)).resolves.toBe('upgraded');
    expectUpgraded(c, 'nventra_dev_pw');
  });

  it('only tries the old default password when the URL uses the new default', async () => {
    const c = FakeCluster.legacy('nodedr_dev_pw');
    await expect(run(c)).resolves.toBe('unavailable');
    expect(c.calls).toEqual([]);
  });

  it('reports unavailable (and changes nothing) when no identity can log in', async () => {
    const c = FakeCluster.legacy();
    c.roles.set(LEGACY_IDENTITY.user, 'other-password');
    await expect(run(c)).resolves.toBe('unavailable');
    expect(c.calls).toEqual([]);
  });

  it.each(['renameRole', 'setPassword', 'renameDb', 'dropRole'])(
    'resumes after a crash at %s',
    async (step) => {
      const c = FakeCluster.legacy();
      c.failOn = step;
      await expect(run(c)).rejects.toThrow(`boom at ${step}`);
      c.failOn = undefined;
      await expect(run(c)).resolves.toMatch(/^(upgraded|current)$/);
      expectUpgraded(c);
    },
  );

  it('refuses when a separate nventra role already exists', async () => {
    const c = FakeCluster.legacy();
    c.roles.set(CURRENT_IDENTITY.user, 'unknown');
    await expect(run(c)).rejects.toThrow(/already exists/);
    expect(c.dbs.has(LEGACY_IDENTITY.database)).toBe(true);
  });
});
