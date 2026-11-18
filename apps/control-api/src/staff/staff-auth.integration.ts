import { ticketCases } from '../helpdesk/tickets/tickets.integration.js';
import { planCases } from '../plans/plans.integration.js';
import { businessCases } from '../business/business.integration.js';
import { staffAccessCases } from './staff-access.integration.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { hash } from 'bcrypt';
import { base32Decode, hotp, stepAt } from '@nventra/types/dist/node/totp';
import { createControlApi } from '../bootstrap.js';
import { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function staffAuthCases(t: TestContext, db: PrismaClient, datasourceUrl: string) {
  const origin = 'https://control.example.test';
  const runtimeUrl = new URL(datasourceUrl);
  runtimeUrl.searchParams.set('options', '-c role=control_runtime');
  const probe = new PrismaClient({ datasourceUrl: runtimeUrl.toString() });
  try {
    const [{ role }] = await probe.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    assert.equal(role, 'control_runtime');
  } finally { await probe.$disconnect(); }
  const { app } = await createControlApi({
    CONTROL_API_PORT: '4002', CONTROL_DATABASE_URL: runtimeUrl.toString(),
    CONTROL_AUTH_KEY: 'a5'.repeat(32), CONTROL_ORIGIN: origin,
  });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const root = (await app.getUrl()) + '/api/control/v1/staff/';
  const email = 'owner@example.test', password = randomBytes(24).toString('hex');
  const id = randomUUID(), verifier = await hash(password, 12);
  await db.$executeRaw`INSERT INTO control.staff (id, email, password_hash) VALUES (${id}::uuid, ${email}, ${verifier})`;
  const post = (path: string, body: unknown, requestOrigin = origin, cookie = '') => fetch(root + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: requestOrigin, cookie },
    body: JSON.stringify(body),
  });
  const proof = Buffer.alloc(32, 0x5a);
  const issue = (expiry: Date) => db.$executeRaw`INSERT INTO control.staff_enrollment_proof
    (staff_id, digest, expires_at) VALUES (${id}::uuid, sha256(${proof}), ${expiry})
    ON CONFLICT (staff_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`;
  const begin = (enrollmentProof?: string) => post('session/challenge', { email, password, enrollmentProof });
  const challenge = async () => {
    const res = await post('session/challenge', { email, password });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    return await res.json() as { challenge: string; enrollmentSecret?: string };
  };
  const getSession = (cookie: string) => fetch(root + 'session', { headers: { cookie } });
  const verify = (token: string, code: string) => post('session/verify', { challenge: token, code });

  await t.test('rejects malformed credentials without returning parser input', async () => {
    const malformed = 'sensitive-marker';
    for (const [requestOrigin, status] of [[origin, 400], ['https://other.example.test', 403]] as const) {
      const res = await fetch(root + 'session/challenge', { method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: requestOrigin }, body: malformed });
      assert.equal(res.status, status);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal((await res.text()).includes(malformed), false);
    }
  });

  await t.test('requires an independent unexpired proof before issuing a first seed', async () => {
    assert.equal((await post('session/challenge', { email: 'unknown@example.test', password })).status, 401);
    assert.equal((await begin()).status, 401);
    await issue(new Date(0));
    assert.equal((await begin(proof.toString('base64url'))).status, 401);
    await issue(new Date(Date.now() + 60_000));
    assert.equal((await begin(Buffer.alloc(32).toString('base64url'))).status, 401);
    assert.equal((await begin('A'.repeat(42) + 'B')).status, 400);
    const pending = await db.staff.findUniqueOrThrow({ where: { id } });
    assert.equal(pending.pendingSeed, null);
  });

  await t.test('consumes enrollment, TOTP and recovery atomically and revokes logout', async () => {
    await db.authLimit.deleteMany();
    const response = () => begin(proof.toString('base64url'));
    const initial = await Promise.all([response(), response()]);
    assert.deepEqual(initial.map((r) => r.status).sort(), [200, 401]);
    const granted = initial.find((r) => r.status === 200)!;
    assert.equal(granted.headers.get('set-cookie'), null);
    assert.equal(granted.headers.get('cache-control'), 'no-store');
    const first = await granted.json() as { challenge: string; enrollmentSecret: string };
    assert.ok(first.enrollmentSecret);
    assert.equal((await getSession('__Host-control_staff=' + first.challenge)).status, 401);
    assert.equal((await verify(first.challenge, '000000')).status, 401);
    const pending = await db.staff.findUniqueOrThrow({ where: { id } });
    assert.ok(pending.pendingSeed && !pending.pendingSeed.includes(first.enrollmentSecret));
    assert.notEqual(pending.challengeDigest, first.challenge);
    const seed = base32Decode(first.enrollmentSecret);
    const step = stepAt(Date.now());
    const enrolled = await post('enrollment', { challenge: first.challenge, code: hotp(seed, step) });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.headers.get('cache-control'), 'no-store');
    const { recoveryCodes } = await enrolled.json() as { recoveryCodes: string[] };
    assert.ok(recoveryCodes.length >= 4);
    const stored = await db.staff.findUniqueOrThrow({ where: { id } });
    assert.ok(stored.encryptedSeed && !stored.encryptedSeed.includes(first.enrollmentSecret));
    assert.equal(stored.pendingSeed, null);
    assert.equal(stored.challengeDigest, null);
    assert.equal(stored.recoveryDigests.length, recoveryCodes.length);
    assert.ok(stored.recoveryDigests.every((v) => /^[a-f0-9]{64}$/.test(v) && !recoveryCodes.includes(v)));
    const second = await challenge();
    assert.equal(second.enrollmentSecret, undefined);
    assert.equal((await verify(second.challenge, hotp(seed, step))).status, 401);
    const code = hotp(seed, step + 1);
    const attempts = await Promise.all([verify(second.challenge, code), verify(second.challenge, code)]);
    assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 401]);
    const cookieHeader = attempts.find((r) => r.status === 200)!.headers.get('set-cookie')!;
    for (const directive of ['__Host-control_staff=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      assert.ok(cookieHeader.includes(directive));
    }
    const cookie = cookieHeader.split(';')[0];
    assert.equal((await getSession(cookie)).status, 200);
    const third = await challenge();
    assert.equal((await verify(third.challenge, code)).status, 401);
    const recover = () => verify(third.challenge, recoveryCodes[0]);
    const recovered = await Promise.all([recover(), recover()]);
    assert.deepEqual(recovered.map((r) => r.status).sort(), [200, 401]);
    const recoveryCookie = recovered.find((r) => r.status === 200)!.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await verify((await challenge()).challenge, recoveryCodes[0])).status, 401);
    assert.equal((await post('session/logout', {}, 'https://other.example.test', cookie)).status, 403);
    assert.equal((await post('session/logout', {}, origin, cookie)).status, 200);
    assert.equal((await getSession(cookie)).status, 401);
    assert.equal((await getSession(recoveryCookie)).status, 200);
    await db.staff.update({ where: { id }, data: { enabled: false } });
    assert.equal((await getSession(recoveryCookie)).status, 401);
    await db.staff.update({ where: { id }, data: { enabled: true } });
    await db.staffSession.updateMany({ where: { staffId: id }, data: { verifiedAt: new Date(0), expiresAt: new Date(1) } });
    assert.equal((await getSession(recoveryCookie)).status, 401);
  });

  await t.test('rejects invalid DTOs, superseded or expired challenges and foreign cookies', async () => {
    await db.authLimit.deleteMany();
    assert.equal((await post('session/challenge', { email, password, role: 'owner' })).status, 400);
    assert.equal((await post('session/verify', { challenge: 'wrong', code: 'bad' })).status, 400);
    const first = await challenge();
    const next = await challenge();
    assert.equal((await verify(first.challenge, 'ABCD-ABCD-ABCD')).status, 401);
    await db.staff.update({ where: { id }, data: { challengeExpiresAt: new Date(0) } });
    assert.equal((await verify(next.challenge, 'ABCD-ABCD-ABCD')).status, 401);
    assert.equal((await getSession('pos_session=unrelated')).status, 401);
  });

  await t.test('limits concurrent second-factor verification across fresh challenges for one account', async () => {
    await db.authLimit.deleteMany();
    const first = await challenge();
    const bad = 'ABCD-ABCD-ABCD';
    const burst = await Promise.all(Array.from({ length: 12 }, () => verify(first.challenge, bad)));
    assert.ok(burst.every((res) => res.status === 401));
    assert.equal((await verify((await challenge()).challenge, bad)).status, 429);
  });

  await t.test('limits simultaneous first-factor attempts by account and peer address', async () => {
    await db.$executeRaw`DELETE FROM control.auth_limit`;
    const burst = (addresses: string[]) => Promise.all(addresses.map((address) =>
      post('session/challenge', { email: address, password: 'invalid-fixture-input' }).then((r) => r.status)));
    const account = await burst(Array<string>(9).fill(email));
    assert.equal(account.filter((s) => s === 429).length, 1);
    await db.$executeRaw`DELETE FROM control.auth_limit`;
    const ip = await burst(Array.from({ length: 25 }, (_, i) => `missing${i}@example.test`));
    assert.equal(ip.filter((s) => s === 429).length, 1);
  });
  await staffAccessCases(t, db, root, origin, password, verifier);
  await businessCases(t, db, new URL('../businesses', root).href, origin);
  await planCases(t, db, new URL('../', root).href, origin);
  await ticketCases(t, db, new URL('../tickets', root).href, origin);
}
