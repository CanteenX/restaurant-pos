jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import {
  RESTORE_ROLE,
  RestoreRoleService,
  deriveRestorePassword,
  restoreConnectionUrl,
} from './restore-role';

describe('restore connection url', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('derives a stable password that differs from the DB password', () => {
    const a = deriveRestorePassword('dbpw');
    expect(a).toBe(deriveRestorePassword('dbpw'));
    expect(a).not.toBe(deriveRestorePassword('other'));
    expect(a).not.toContain('dbpw');
  });

  it('prefers an explicit DATABASE_RESTORE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://nventra:dbpw@db:5432/app';
    process.env.DATABASE_RESTORE_URL = 'postgresql://r:pw@db:5432/app';
    expect(restoreConnectionUrl()).toBe('postgresql://r:pw@db:5432/app');
  });

  it('otherwise derives the limited-role URL from DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://nventra:dbpw@db:5432/app?x=1';
    delete process.env.DATABASE_RESTORE_URL;
    const u = new URL(restoreConnectionUrl()!);
    expect(u.username).toBe(RESTORE_ROLE);
    expect(u.password).toBe(deriveRestorePassword('dbpw'));
    expect(u.hostname).toBe('db');
    expect(u.pathname).toBe('/app');
  });
});

describe('RestoreRoleService', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://nventra:dbpw@db:5432/app';
    delete process.env.DATABASE_RESTORE_URL;
  });

  function make(isSuper: boolean) {
    const sql: string[] = [];
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ rolsuper: isSuper }]),
      $executeRawUnsafe: jest.fn((q: string) => {
        sql.push(q);
        return Promise.resolve(0);
      }),
    };
    return { svc: new RestoreRoleService(prisma as never), prisma, sql };
  }

  it('creates a least-privilege role when connected as superuser', async () => {
    const { svc, sql } = make(true);
    await svc.ensure();
    const all = sql.join('\n');
    expect(all).toMatch(/NOSUPERUSER/);
    expect(all).toMatch(/NOCREATEROLE/);
    expect(all).toMatch(/NOCREATEDB/);
    expect(all).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES/,
    );
    expect(all).toMatch(/GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES/);
    expect(all).not.toMatch(/pg_execute_server_program|pg_write_server_files/);
    expect(all).not.toMatch(/GRANT ALL/i);
    expect(all.includes(deriveRestorePassword('dbpw'))).toBe(false);
    expect(all).toMatch(/SCRAM-SHA-256\$4096:/);
  });

  it('leaves an operator-set DATABASE_RESTORE_URL role alone', async () => {
    process.env.DATABASE_RESTORE_URL = 'postgresql://r:pw@db:5432/app';
    const { svc, sql } = make(true);
    await svc.ensure();
    expect(sql).toHaveLength(0);
  });

  it('does nothing when the app is not a superuser', async () => {
    const { svc, sql } = make(false);
    await svc.ensure();
    expect(sql).toHaveLength(0);
  });

  it('never throws at startup if provisioning fails', async () => {
    const { svc, prisma } = make(true);
    prisma.$executeRawUnsafe.mockRejectedValue(new Error('boom'));
    await expect(svc.ensure()).resolves.toBeUndefined();
  });
});
