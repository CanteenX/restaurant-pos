import { describeExecError, pgEnvFromUrl, redactSecrets } from './pg-env';

describe('pgEnvFromUrl', () => {
  it('splits a postgres URL into libpq env vars (password never in argv)', () => {
    expect(
      pgEnvFromUrl('postgresql://nventra:S3cret%40pw@db.local:6543/pos'),
    ).toEqual({
      PGHOST: 'db.local',
      PGPORT: '6543',
      PGUSER: 'nventra',
      PGPASSWORD: 'S3cret@pw',
      PGDATABASE: 'pos',
    });
  });

  it('maps sslmode and drops Prisma-only params such as schema', () => {
    expect(
      pgEnvFromUrl('postgres://u:p@h/d?schema=public&sslmode=require'),
    ).toEqual({
      PGHOST: 'h',
      PGUSER: 'u',
      PGPASSWORD: 'p',
      PGDATABASE: 'd',
      PGSSLMODE: 'require',
    });
  });

  it('rejects a missing or non-postgres URL', () => {
    expect(() => pgEnvFromUrl(undefined)).toThrow(/DATABASE_URL/);
    expect(() => pgEnvFromUrl('mysql://u:p@h/d')).toThrow(/DATABASE_URL/);
  });
});

describe('redactSecrets', () => {
  it('masks URL credentials and password assignments', () => {
    const msg =
      'Command failed: pg_dump postgresql://nventra:S3cretPw@127.0.0.1:1/db PGPASSWORD=S3cretPw';
    const out = redactSecrets(msg);
    expect(out).not.toContain('S3cretPw');
    expect(out).toContain('postgresql://nventra:***@127.0.0.1:1/db');
    expect(out).toContain('PGPASSWORD=***');
  });

  it('masks a known secret wherever it appears', () => {
    expect(redactSecrets('auth failed for hunter2!', ['hunter2'])).toBe(
      'auth failed for ***!',
    );
  });

  it('leaves ordinary messages alone', () => {
    expect(redactSecrets('ENOSPC: no space left on device')).toBe(
      'ENOSPC: no space left on device',
    );
  });
});

describe('describeExecError', () => {
  it('prefers stderr over the argv-bearing message', () => {
    const err = Object.assign(
      new Error('Command failed: pg_dump postgresql://u:pw@h/d'),
      { stderr: 'pg_dump: error: connection refused\n' },
    );
    expect(describeExecError('pg_dump', err)).toBe(
      'pg_dump failed: pg_dump: error: connection refused',
    );
  });

  it('falls back to the message when there is no stderr', () => {
    expect(describeExecError('tar', new Error('spawn tar ENOENT'))).toBe(
      'tar failed: spawn tar ENOENT',
    );
  });
});
