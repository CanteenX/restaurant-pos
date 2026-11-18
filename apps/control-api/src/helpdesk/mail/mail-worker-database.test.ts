import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { verifyMailWorkerDatabase } from './mail-worker-database.ts';

const redacted = { message: 'Mail worker database connection refused' };

void test('redacts identity failures and disconnects the unverified client', async () => {
  for (const verify of [
    () => Promise.resolve([{ dedicated: false }]),
    () => Promise.resolve([]),
    () => Promise.reject(new Error('synthetic database detail')),
  ]) {
    let disconnected = 0;
    const db = {
      $queryRaw: verify,
      $disconnect: () => { disconnected++; return Promise.reject(new Error('synthetic cleanup detail')); },
    } as unknown as PrismaClient;
    await assert.rejects(verifyMailWorkerDatabase(db, new AbortController().signal), redacted);
    assert.equal(disconnected, 1);
  }

  const cancel = new AbortController();
  cancel.abort();
  let disconnected = false;
  const db = {
    $queryRaw: () => { assert.fail('An already cancelled request queried PostgreSQL'); },
    $disconnect: () => { disconnected = true; return Promise.resolve(); },
  } as unknown as PrismaClient;
  await assert.rejects(verifyMailWorkerDatabase(db, cancel.signal), redacted);
  assert.equal(disconnected, true);
});

const fixtureUrl = process.env.CONTROL_MAIL_WORKER_TEST_DATABASE_URL;

void test('checks the actual dedicated PostgreSQL login and its inherited worker privileges', { skip: !fixtureUrl }, async (t) => {
  assert.ok(fixtureUrl && URL.canParse(fixtureUrl));
  const url = new URL(fixtureUrl);
  assert.ok(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.username === 'mail_fixture' &&
    Number(url.port) >= 32768 && url.pathname === '/control_mail_worker_test' && !url.search && !url.hash,
  'Use a disposable loopback mail worker database');
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  t.after(() => db.$disconnect());
  await db.$executeRaw`CREATE SCHEMA control`;
  await db.$executeRaw`CREATE ROLE control_mail_worker NOLOGIN`;
  await db.$executeRaw`CREATE ROLE control_runtime NOLOGIN`;
  await db.$executeRaw`CREATE ROLE control_staff_operator NOLOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_worker LOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_noinherit LOGIN NOINHERIT`;
  await db.$executeRaw`CREATE ROLE fixture_staff LOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_operator LOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_owner LOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_elevated LOGIN BYPASSRLS`;
  await db.$executeRaw`CREATE ROLE fixture_no_grants LOGIN`;
  await db.$executeRaw`CREATE ROLE fixture_schema_writer LOGIN`;
  await db.$executeRaw`GRANT control_mail_worker TO fixture_worker, fixture_noinherit, fixture_staff,
    fixture_operator, fixture_owner, fixture_elevated, fixture_schema_writer`;
  await db.$executeRaw`GRANT control_runtime TO fixture_staff`;
  await db.$executeRaw`GRANT control_staff_operator TO fixture_operator`;
  await db.$executeRaw`GRANT mail_fixture TO fixture_owner`;
  await db.$executeRaw`GRANT USAGE ON SCHEMA control TO control_mail_worker`;
  await db.$executeRaw`GRANT CREATE ON SCHEMA control TO fixture_schema_writer`;

  const connect = (username: string, options?: string) => {
    const uri = new URL(url);
    uri.username = username;
    if (options) uri.searchParams.set('options', options);
    return new PrismaClient({ datasourceUrl: uri.toString() });
  };
  const signal = new AbortController().signal, worker = connect('fixture_worker');
  t.after(() => worker.$disconnect());
  assert.equal(await verifyMailWorkerDatabase(worker, signal), worker);
  for (const login of ['fixture_noinherit', 'fixture_staff', 'fixture_operator', 'fixture_owner',
    'fixture_elevated', 'fixture_no_grants', 'fixture_schema_writer', 'mail_fixture']) {
    await assert.rejects(verifyMailWorkerDatabase(connect(login), signal), redacted, login);
  }
  await assert.rejects(verifyMailWorkerDatabase(connect('fixture_worker', '-c role=control_mail_worker'), signal), redacted);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION fixture_worker`;
    const [reported] = await tx.$queryRaw<{ effective: string; session: string }[]>`
      SELECT current_user::text AS effective, session_user::text AS session`;
    assert.deepEqual(reported, { effective: 'fixture_worker', session: 'fixture_worker' });
    const session = { $queryRaw: tx.$queryRaw.bind(tx), $disconnect: () => Promise.resolve() };
    await assert.rejects(verifyMailWorkerDatabase(session, signal), redacted);
  });
  await db.$executeRaw`REVOKE USAGE ON SCHEMA control FROM control_mail_worker`;
  await assert.rejects(verifyMailWorkerDatabase(connect('fixture_worker'), signal), redacted);
});
