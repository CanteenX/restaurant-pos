import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { verifyMailWorkerDatabase } from './mail-worker-database.ts';

import { openScheduledMailWorker } from './scheduled-mail-worker.ts';
import { runMailJob } from './run-mail-job.ts';
import type { EnabledMailJobConfig } from './mail-job-config.ts';

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

  // The same disposable database now exercises the actual migrated inbox and outbox.
  for (const args of [['migrate', 'deploy'], ['db', 'execute', '--file', 'operator/mail-worker-grants.sql', '--schema', 'prisma/schema.prisma']]) {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
      env: { ...process.env, CONTROL_DATABASE_URL: url.toString() }, stdio: 'ignore', timeout: 60_000,
    });
  }
  const workerUrl = new URL(url);
  workerUrl.username = 'fixture_worker';
  const env = { CONTROL_MAIL_ENABLED: 'true', CONTROL_MAIL_RETENTION_DAYS: '90',
    CONTROL_MAIL_DATABASE_URL: workerUrl.toString(), CONTROL_GMAIL_USER: 'fixture@example.test',
    CONTROL_GMAIL_APP_PASSWORD: 'x'.repeat(16) };
  const mailbox = env.CONTROL_GMAIL_USER;
  let polls = 0, sends = 0;
  const open = (config: EnabledMailJobConfig, jobSignal: AbortSignal) => openScheduledMailWorker(config, jobSignal, {
    imap: () => ({ mailbox, poll: ({ afterUid }) => {
      polls++;
      if (polls === 2) return Promise.reject(new Error('synthetic disconnected transport'));
      if (polls === 3) return Promise.resolve({ status: 'resync', uidValidity: '2' });
      assert.equal(afterUid, 0);
      return Promise.resolve({ status: 'batch', uidValidity: '1', throughUid: 1, messages: [{
        uid: 1, providerId: 'fixture-original', result: { disposition: 'accept', reason: 'accepted', omittedAttachments: 0 },
        text: 'Incoming support mail', envelope: { from: [{ address: 'customer@example.test' }],
          messageId: '<fixture-first@example.test>', subject: 'Printer support' },
      }] });
    } }),
    smtp: () => ({ send: (mail) => {
      sends++;
      assert.equal(mail.to, 'customer@example.test');
      assert.equal(mail.inReplyTo, '<fixture-first@example.test>');
      return Promise.resolve({ status: 'sent', messageId: mail.messageId });
    } }),
  });
  assert.equal(await runMailJob('inbox', { ...env, CONTROL_MAIL_DATABASE_URL: url.toString() }, open), 'failed');
  assert.deepEqual([polls, sends], [0, 0]);
  assert.equal(await runMailJob('inbox', env, open), 'complete');
  assert.equal(await runMailJob('inbox', env, open), 'failed');
  const { message } = await db.inboundReceipt.findUniqueOrThrow({
    where: { mailbox_providerId: { mailbox, providerId: 'fixture-original' } }, include: { message: true },
  });
  assert.ok(message);
  const { id: author } = await db.staff.create({
    data: { id: randomUUID(), email: 'author@example.test', passwordHash: 'inert' }, select: { id: true },
  });
  const row = randomUUID();
  await db.$executeRaw`SELECT control.enqueue_ticket_reply(${row}::uuid,${message.ticketId}::uuid,${message.id}::uuid,
    ${author}::uuid,${randomUUID()}::uuid,'Reply',${'<' + row + '@nventra.invalid>'},'Support','Reply','<p>Reply</p>',true)`;
  assert.equal(await runMailJob('outbox', env, open), 'complete');
  assert.equal(await runMailJob('outbox', env, open), 'complete');
  assert.equal(sends, 1);
  const [outbox] = await db.$queryRaw<{ state: string }[]>`SELECT state FROM control.ticket_reply_outbox WHERE message_row_id=${row}::uuid`;
  assert.equal(outbox.state, 'sent');
  assert.equal(await runMailJob('inbox', env, open), 'complete');
  const cursor = await db.mailboxCursor.findUniqueOrThrow({ where: { mailbox } });
  assert.deepEqual([cursor.uidValidity, cursor.throughUid, cursor.leaseToken], [2n, 0n, null]);
});
