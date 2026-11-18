import { operatorCases } from '../operator/operator.integration.js';
import { staffAuthCases } from '../staff/staff-auth.integration.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { ZodError } from 'zod';

import { Prisma, PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent, captureAuditCheckpoint, verifyAuditCheckpoint } from './audit.js';

const ci = process.env.GITHUB_ACTIONS === 'true';
const explicitTestUrl = process.env.CONTROL_AUDIT_TEST_DATABASE_URL;
const testUrl = explicitTestUrl ?? (ci ? process.env.DATABASE_URL : undefined);

const event = {
  actorType: 'staff',
  actorId: '00000000-0000-4000-8000-000000000001',
  action: 'business.updated',
  subjectType: 'business',
  subjectId: '00000000-0000-4000-8000-000000000002',
  requestId: '00000000-0000-4000-8000-000000000003',
  outcome: 'succeeded',
  changedFields: ['displayName', 'timezone'],
} as const;

void test('PostgreSQL 16 Control audit storage', { skip: !ci && !testUrl }, async (t) => {
  assert.ok(testUrl);
  assert.ok(URL.canParse(testUrl), 'Invalid audit fixture connection configuration');
  const url = new URL(testUrl);
  assert.ok(url.protocol === 'postgresql:' && ['localhost', '127.0.0.1'].includes(url.hostname),
    'Use disposable loopback PostgreSQL');
  assert.ok(url.pathname === (explicitTestUrl ? '/control_audit_test' : '/ci'),
    'Use the dedicated audit fixture database');

  if (!explicitTestUrl) {
    const admin = new PrismaClient({ datasourceUrl: testUrl });
    try {
      await admin.$executeRaw`CREATE DATABASE control_audit_test`;
    } finally {
      await admin.$disconnect();
    }
  }
  url.pathname = '/control_audit_test';
  url.searchParams.set('schema', 'control');
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  t.after(() => db.$disconnect());
  await db.$executeRaw`CREATE ROLE control_runtime NOLOGIN`;
  await db.$executeRaw`CREATE ROLE control_audit_ungranted NOLOGIN`;
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    env: { ...process.env, CONTROL_DATABASE_URL: url.toString() },
    stdio: 'ignore',
    timeout: 60_000,
  });

  const runtime = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      return work(tx);
    }, { timeout: 20_000 });

  await t.test('serializes concurrent appends and verifies a portable checkpoint', async () => {
    const genesis = await captureAuditCheckpoint(db);
    assert.equal(genesis.sequence, '0');
    assert.ok(await verifyAuditCheckpoint(db, genesis));
    await Promise.all(Array.from({ length: 6 }, () => runtime((tx) => appendAuditEvent(tx, event))));
    const snapshot = await captureAuditCheckpoint(db);
    assert.equal(snapshot.sequence, '6');
    assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
    assert.ok(await verifyAuditCheckpoint(db, snapshot));

    await runtime((tx) => appendAuditEvent(tx, {
      ...event, businessId: event.actorId, subjectId: null, changedFields: undefined,
    }));
    assert.ok(await verifyAuditCheckpoint(db, snapshot), 'a previously retained checkpoint stays valid');
    assert.ok(await verifyAuditCheckpoint(db, await captureAuditCheckpoint(db)));
  });

  await t.test('rolls the append back with its caller transaction', async () => {
    const before = await captureAuditCheckpoint(db);
    await assert.rejects(runtime(async (tx) => {
      await appendAuditEvent(tx, event);
      throw new Error('roll back caller work');
    }), /roll back caller work/);
    assert.deepEqual(await captureAuditCheckpoint(db), before);
  });

  await t.test('denies runtime writes except through append and rejects invalid data', async () => {
    const sqlState = (code: string) => (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === code;
    const [{ allowed }] = await db.$queryRaw<{ allowed: boolean }[]>`
      SELECT has_function_privilege(
        'control_audit_ungranted',
        'control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[])',
        'EXECUTE'
      ) AS allowed
    `;
    assert.equal(allowed, false);
    for (const sql of [
      Prisma.sql`UPDATE control.audit_event SET action = 'changed' WHERE sequence = 1`,
      Prisma.sql`DELETE FROM control.audit_event WHERE sequence = 1`,
      Prisma.sql`TRUNCATE control.audit_event`,
      Prisma.sql`INSERT INTO control.audit_event (sequence) VALUES (100)`,
    ]) {
      await assert.rejects(runtime((tx) => tx.$executeRaw(sql)), sqlState('42501'));
    }
    await assert.rejects(runtime((tx) => appendAuditEvent(tx, {
      ...event, changedFields: ['not a field'],
    })), ZodError);
    await assert.rejects(runtime((tx) => tx.$queryRaw`
      SELECT control.append_audit_event(
        'staff', ${event.actorId}::uuid, NULL, 'business.updated', 'business', NULL,
        ${event.requestId}::uuid, 'succeeded', ARRAY['not a field']
      )
    `), sqlState('23514'));
    assert.equal((await runtime((tx) => captureAuditCheckpoint(tx))).sequence, '7');
    const snapshot = await captureAuditCheckpoint(db);
    assert.equal(await verifyAuditCheckpoint(db, { ...snapshot, sequence: 'broken' }), false);
    assert.equal(await verifyAuditCheckpoint(db, { ...snapshot, sequence: '9999999999999999999' }), false);
  });


  await t.test('accepts only canonical field arrays at the database boundary', async () => {
    const invalidFields = [
      Prisma.sql`ARRAY['displayName,timezone']`,
      Prisma.sql`'[0:1]={displayName,timezone}'::text[]`,
      Prisma.sql`ARRAY[ARRAY['displayName'], ARRAY['timezone']]`,
      Prisma.sql`ARRAY['displayName', NULL]`,
    ];
    for (const fields of invalidFields) {
      await assert.rejects(runtime(async (tx) => {
        await tx.$queryRaw`
          SELECT control.append_audit_event(
            'staff', ${event.actorId}::uuid, NULL, 'business.updated', 'business', NULL,
            ${event.requestId}::uuid, 'succeeded', ${fields}
          )
        `;
        throw new Error('roll back invalid fixture');
      }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError &&
        error.meta?.code === '23514');
    }
  });

  await t.test('binds field-array element boundaries to the retained checkpoint', async () => {
    const snapshot = await captureAuditCheckpoint(db);
    await assert.rejects(db.$transaction(async (tx) => {
      // Simulate storage corruption using the fixture's database owner.
      await tx.$executeRaw`
        ALTER TABLE control.audit_event DROP CONSTRAINT audit_event_changed_fields_check
      `;
      await tx.$executeRaw`
        UPDATE control.audit_event SET changed_fields = ARRAY['displayName,timezone'] WHERE sequence = 1
      `;
      assert.equal(await verifyAuditCheckpoint(tx, snapshot), false);
      throw new Error('restore the fixture');
    }), /restore the fixture/);
  });

  await t.test('resolves catalog names ahead of temporary objects in the append function', async () => {
    const [{ proconfig }] = await db.$queryRaw<{ proconfig: string[] }[]>`
      SELECT proconfig FROM pg_catalog.pg_proc
      WHERE oid = 'control.append_audit_event(text,uuid,uuid,text,text,uuid,uuid,text,text[])'::regprocedure
    `;
    assert.deepEqual(proconfig, ['search_path=pg_catalog, pg_temp']);
  });

  await t.test('detects data and chain tampering against an independently retained checkpoint', async () => {
    const snapshot = await captureAuditCheckpoint(db);
    await db.$executeRaw`UPDATE control.audit_event SET action = 'business.deleted' WHERE sequence = 1`;
    assert.equal(await verifyAuditCheckpoint(db, snapshot), false);
    await db.$executeRaw`UPDATE control.audit_event SET action = 'business.updated' WHERE sequence = 1`;
    await db.$executeRaw`DELETE FROM control.audit_event WHERE sequence = 2`;
    assert.equal(await verifyAuditCheckpoint(db, snapshot), false);
  });

  await t.test('staff runtime cannot issue enrollment proofs or provision identities', async () => {
    const denied = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === '42501';
    await db.$executeRaw`INSERT INTO control.staff (id, email, password_hash)
      VALUES (${event.actorId}::uuid, 'storage@example.test', 'inert-fixture-verifier')`;
    for (const statement of [
      Prisma.sql`INSERT INTO control.staff (id) VALUES (${event.requestId}::uuid)`,
      Prisma.sql`UPDATE control.staff SET password_hash = 'changed'`,
      Prisma.sql`UPDATE control.staff SET enabled = false`,
      Prisma.sql`SELECT digest FROM control.staff_enrollment_proof`,
      Prisma.sql`INSERT INTO control.staff_enrollment_proof (staff_id) VALUES (${event.actorId}::uuid)`,
      Prisma.sql`UPDATE control.staff_enrollment_proof SET expires_at = now()`,
      Prisma.sql`DELETE FROM control.staff_enrollment_proof`,
    ]) await assert.rejects(runtime((tx) => tx.$queryRaw(statement)), denied);
    await runtime((tx) => tx.$executeRaw`UPDATE control.staff SET last_step = 1 WHERE id = ${event.actorId}::uuid`);
    const [{ allowed }] = await db.$queryRaw<{ allowed: boolean }[]>`SELECT has_function_privilege(
      'control_audit_ungranted', 'control.consume_staff_enrollment(uuid,bytea)', 'EXECUTE') AS allowed`;
    assert.equal(allowed, false);
    const [{ fixed }] = await db.$queryRaw<{ fixed: boolean }[]>`SELECT prosecdef AND
      proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AS fixed FROM pg_catalog.pg_proc
      WHERE oid = 'control.consume_staff_enrollment(uuid,bytea)'::regprocedure`;
    assert.equal(fixed, true);
  });

  await t.test('an eligible staff member can consume an unexpired enrollment proof exactly once', async () => {
    const proof = Buffer.alloc(32, 0x5a);
    const provision = (expiry: Date) => db.$executeRaw`INSERT INTO control.staff_enrollment_proof
      (staff_id, digest, expires_at) VALUES (${event.actorId}::uuid, sha256(${proof}), ${expiry})
      ON CONFLICT (staff_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`;
    const consume = async (tx: Prisma.TransactionClient, id: string = event.actorId, bytes = proof) => {
      const [{ used }] = await tx.$queryRaw<{ used: boolean }[]>`SELECT control.consume_staff_enrollment(
        ${id}::uuid, ${bytes}::bytea) AS used`;
      return used;
    };
    await provision(new Date(0));
    assert.equal(await runtime((tx) => consume(tx)), false);
    await provision(new Date(Date.now() + 60_000));
    assert.equal(await runtime((tx) => consume(tx, event.requestId)), false);
    assert.equal(await runtime((tx) => consume(tx, event.actorId, Buffer.alloc(32))), false);
    await db.$executeRaw`UPDATE control.staff SET enabled = false WHERE id = ${event.actorId}::uuid`;
    assert.equal(await runtime((tx) => consume(tx)), false);
    await db.$executeRaw`UPDATE control.staff SET enabled = true, encrypted_seed = 'inert' WHERE id = ${event.actorId}::uuid`;
    await provision(new Date(Date.now() + 60_000)); // Re-enabling invalidates the old proof.
    assert.equal(await runtime((tx) => consume(tx)), false);
    await db.$executeRaw`UPDATE control.staff SET encrypted_seed = NULL WHERE id = ${event.actorId}::uuid`;
    await assert.rejects(runtime(async (tx) => {
      assert.equal(await consume(tx), true);
      throw new Error('caller rollback');
    }), /caller rollback/);
    assert.deepEqual((await Promise.all([runtime((tx) => consume(tx)), runtime((tx) => consume(tx))])).sort(),
      [false, true]);
  });

  await t.test('runtime sessions require ordered expiry and a unique digest', async () => {
    const insert = (end: Date) => runtime((tx) => tx.$executeRaw`INSERT INTO control.staff_session
      (digest, staff_id, verified_at, expires_at) VALUES (repeat('a',64), ${event.actorId}::uuid, now(), ${end})`);
    const state = (code: string) => (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.meta?.code === code;
    await assert.rejects(insert(new Date(0)), state('23514'));
    const expiry = new Date(Date.now() + 60_000);
    await insert(expiry);
    await assert.rejects(insert(expiry), state('23505'));
  });
  await t.test('Control staff authentication', async (staff) => staffAuthCases(staff, db, url.toString()));
  await t.test('Control staff operator provisioning', (stage) => operatorCases(stage, db, url.toString()));
});
