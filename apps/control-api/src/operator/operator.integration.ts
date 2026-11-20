import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CONTROL_ROLE_PRESETS } from '@nventra/types';
import { base32Decode, hotp, stepAt } from '@nventra/types/dist/node/totp';
import { compare } from 'bcrypt';
import { createControlApi } from '../bootstrap.js';
import { Prisma, type PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function operatorCases(t: TestContext, db: PrismaClient, fixtureUrl: string) {
  const email = 'operator-owner@example.test', password = 'public fixture passphrase';
  const proof = Buffer.alloc(32, 42).toString('base64url'), fresh = Buffer.alloc(32, 43).toString('base64url');
  const resetProof = Buffer.alloc(32, 44).toString('base64url');
  const create = { operation: 'create', email: email.toUpperCase(), preset: 'OWNER', password, proof };
  const run = (input: unknown, url: string, extra: string[] = [], debug = '') =>
    spawnSync(process.execPath, ['dist/operator/provision.js', ...extra], {
      input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DEBUG: debug, RUST_LOG: '', NODE_DEBUG: '', CONTROL_OPERATOR_DATABASE_URL: url },
    });
  const failure = (result: ReturnType<typeof run>) => {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Staff provisioning failed.\n');
  };
  await t.test('rejects malformed, oversized and unexpected input with a fixed diagnostic', () => {
    for (const input of ['{private-marker', 'x'.repeat(4097), { ...create, preset: 'other' },
      { ...create, password: 'x'.repeat(73) }, { ...create, proof: 'invalid' }, { ...create, extra: true }]) {
      failure(run(input, fixtureUrl));
    }
    failure(run(create, fixtureUrl, ['unexpected']));
    failure(run(create, 'https://invalid.example.test'));
    failure(run(create, ''));
    failure(run({ ...create, password: proof }, fixtureUrl));
    failure(run(create, fixtureUrl, [], 'prisma:*'));
  });

  const sqlFile = (file: string) => execFileSync(process.execPath,
    [require.resolve('prisma/build/index.js'), 'db', 'execute', '--file', 'operator/' + file, '--schema', 'prisma/schema.prisma'],
    { env: { ...process.env, CONTROL_DATABASE_URL: fixtureUrl }, stdio: 'ignore', timeout: 30_000 });
  await db.$executeRaw`CREATE ROLE control_staff_operator NOLOGIN`;
  sqlFile('install.sql');
  await db.$executeRaw`CREATE ROLE cc295_operator_fixture LOGIN PASSWORD 'public_loopback_fixture' IN ROLE control_staff_operator`;
  const operator = new URL(fixtureUrl);
  operator.username = 'cc295_operator_fixture';
  operator.password = 'public_loopback_fixture';
  const runtime = new URL(fixtureUrl);
  runtime.searchParams.set('options', '-c role=control_runtime');
  await t.test('runtime cannot invoke the function and operator has no direct staff or proof access', async () => {
    const [row] = await db.$queryRaw<{ permitted: boolean; direct: boolean; fixed: boolean }[]>`
      SELECT has_function_privilege('control_runtime', p.oid, 'EXECUTE') AS permitted,
        has_any_column_privilege('cc295_operator_fixture','control.staff','UPDATE,INSERT,SELECT')
        OR has_any_column_privilege('cc295_operator_fixture','control.staff_enrollment_proof','SELECT,UPDATE,INSERT') AS direct,
        p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AS fixed
      FROM pg_proc p WHERE p.oid='control.provision_staff(text,text,text,text[],bytea)'::regprocedure`;
    assert.deepEqual(row, { permitted: false, direct: false, fixed: true });
    const access = await db.$queryRaw<{ exposed: boolean }[]>`SELECT
      has_any_column_privilege(role_name, 'control.staff_proof_issuance','SELECT,INSERT,UPDATE')
      OR has_table_privilege(role_name, 'control.staff_proof_issuance','DELETE,TRUNCATE') AS exposed
      FROM (VALUES ('control_runtime'), ('cc295_operator_fixture')) AS roles(role_name)`;
    assert.deepEqual(access, [{ exposed: false }, { exposed: false }]);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$executeRaw`SELECT control.provision_staff('rotate', ${email}, NULL, NULL, NULL)`;
    }), (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.meta?.code === '42501');
    failure(run(create, runtime.toString()));
    failure(run(create, fixtureUrl)); // reject the migration owner as an operator login
  });
  const ok = (input: unknown) => {
    const res = run(input, operator.toString());
    assert.equal(res.status, 0);
    assert.equal(res.stdout + res.stderr, '');
  };
  const rotate = { operation: 'rotate', email, proof: fresh };
  await t.test('uses the catalog grants for invited Support, Manager and Marketing accounts and rejects unknown targets', async () => {
    for (const preset of ['SUPPORT', 'MANAGER', 'MARKETING'] as const) {
      const invited = preset.toLowerCase() + '-operator@example.test';
      ok({ ...create, email: invited, preset });
      const staff = await db.staff.findUniqueOrThrow({ where: { email: invited } });
      assert.deepEqual(staff.grants, [...CONTROL_ROLE_PRESETS[preset]]);
    }
    failure(run({ ...rotate, email: 'absent@example.test' }, operator.toString()));
  });
  await t.test('creates normalized owner with explicit grants, verifier, short-lived digest and atomic audit', async () => {
    ok(create);
    failure(run({ ...create, preset: 'SUPPORT' }, operator.toString()));
    const staff = await db.staff.findUniqueOrThrow({ where: { email } });
    assert.deepEqual(staff.grants, [...CONTROL_ROLE_PRESETS.OWNER]);
    assert.ok(await compare(password, staff.passwordHash));
    const issued = await db.staffEnrollmentProof.findUniqueOrThrow({ where: { staffId: staff.id } });
    assert.ok(Buffer.from(issued.digest).equals(createHash('sha256').update(Buffer.from(proof, 'base64url')).digest()));
    const ttl = issued.expiresAt.getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= 15 * 60_000);
    const events = await db.auditEvent.findMany({ where: { subjectId: staff.id } });
    assert.deepEqual(events.map((e) => [e.actorType, e.action, e.changedFields]), [['system', 'staff.provision', []]]);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT fixture_provision_fail CHECK
      (action <> 'staff.provision' AND action <> 'staff.issueProof') NOT VALID`;
    try {
      failure(run({ ...create, email: 'rollback@example.test' }, operator.toString()));
      failure(run(rotate, operator.toString()));
      assert.equal(await db.staff.count({ where: { email: 'rollback@example.test' } }), 0);
      assert.deepEqual(await db.staffEnrollmentProof.findUnique({ where: { staffId: staff.id } }), issued);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT fixture_provision_fail`; }
  });
  await t.test('operator-owned enrollment requires independent proof, reissue invalidates previous challenges and sessions', async () => {
    const origin = 'https://operator.example.test';
    const { app } = await createControlApi({ CONTROL_API_PORT: '4002', CONTROL_DATABASE_URL: runtime.toString(),
      CONTROL_AUTH_KEY: '35'.repeat(32), CONTROL_ORIGIN: origin });
    await app.listen(0, '127.0.0.1');
    try {
      const root = (await app.getUrl()) + '/api/control/v1/staff/';
      const post = (path: string, body: unknown) => fetch(root + path, { method: 'POST',
        headers: { origin, connection: 'close', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const begin = (enrollmentProof?: string) => post('session/challenge', { email, password, enrollmentProof });
      type Challenge = { challenge: string; enrollmentSecret: string };
      const enroll = (x: Challenge) => post('enrollment', { challenge: x.challenge,
        code: hotp(base32Decode(x.enrollmentSecret), stepAt(Date.now())) });
      assert.equal((await begin()).status, 401);
      const first = await (await begin(proof)).json() as Challenge;
      ok(rotate); // replacement after a lost challenge response
      failure(run(rotate, operator.toString())); // retry cannot extend the lifetime of an outstanding proof
      assert.equal((await enroll(first)).status, 401);
      assert.equal((await begin(proof)).status, 401);
      const current = await (await begin(fresh)).json() as Challenge;
      failure(run(rotate, operator.toString())); // previously consumed, challenge is still usable
      assert.equal((await begin(fresh)).status, 401);
      const enrolled = await enroll(current);
      assert.equal(enrolled.status, 200);
      const cookie = enrolled.headers.get('set-cookie')!.split(';')[0];
      const session = () => fetch(root + 'session', { headers: { cookie, connection: 'close' } });
      assert.equal((await session()).status, 200);
      failure(run(rotate, operator.toString()));
      await db.$executeRaw`UPDATE control.staff SET encrypted_seed = NULL, recovery_digests = '{}', last_step = NULL,
        credential_version = credential_version + 1 WHERE email = ${email}`;
      assert.equal((await session()).status, 401);
      assert.equal((await begin()).status, 401);
      sqlFile('uninstall.sql');
      sqlFile('install.sql');
      failure(run({ ...rotate, proof }, operator.toString()));
      failure(run(rotate, operator.toString()));
      ok({ ...rotate, proof: resetProof });
      assert.equal((await begin(fresh)).status, 401);
      assert.equal((await begin(resetProof)).status, 200);
      assert.equal((await session()).status, 401);
      await db.staff.update({ where: { email }, data: { enabled: false } });
      failure(run(rotate, operator.toString()));
    } finally { await app.close(); }
  });
  sqlFile('uninstall.sql');
  assert.equal(await db.staff.count({ where: { email } }), 1);
  await db.$executeRaw`DROP ROLE cc295_operator_fixture`;
  await db.$executeRaw`DROP ROLE control_staff_operator`;
}
