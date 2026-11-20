import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { base32Decode, hotp, stepAt } from '@nventra/types/dist/node/totp';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function staffInviteCases(t: TestContext, db: PrismaClient, root: string, origin: string) {
  const admin = await db.staffRole.findUniqueOrThrow({ where: { key: 'admin' } });
  const manager = await db.staffRole.findUniqueOrThrow({ where: { key: 'manager' } });
  const support = await db.staffRole.findUniqueOrThrow({ where: { key: 'support' } });
  const key = 'a5'.repeat(32);
  const makeSession = async (staffId: string, age = 0) => {
    const raw = randomBytes(32).toString('base64url');
    const digest = createHmac('sha256', key).update('session\0' + raw).digest('hex');
    await db.staffSession.create({ data: { digest, staffId, verifiedAt: new Date(Date.now() - age),
      expiresAt: new Date(Date.now() + 600_000) } });
    return '__Host-control_staff=' + raw;
  };
  async function actor(roleId: string, grants: string[]) {
    const id = randomUUID();
    await db.staff.create({ data: { id, roleId, grants, email: id + '@example.test', passwordHash: 'fixture-inert' } });
    return { id, cookie: await makeSession(id) };
  }
  const owner = await actor(admin.id, admin.grants);
  const lesser = await actor(manager.id, manager.grants);
  const supportUser = await actor(support.id, support.grants);
  const post = (path: string, body: unknown, cookie = '', callerOrigin = origin) => fetch(root + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: callerOrigin, cookie }, body: JSON.stringify(body),
  });
  const current = (cookie: string) => fetch(root + 'session', { headers: { cookie } });
  const invite = (email: string, roleId: string, cookie = owner.cookie, tweaks = {}) =>
    post('users/invite', { email, roleId, ...tweaks }, cookie);
  const change = (id: string, action: 'activate' | 'deactivate', cookie = owner.cookie) =>
    post('users/' + id + '/' + (action === 'activate' ? 'reactivate' : action), {}, cookie);
  const tokenFrom = async (response: Response) => {
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const issued = await response.json() as { inviteLink: string; expiresAt: string };
    const url = new URL(issued.inviteLink);
    assert.equal(url.origin, origin);
    assert.equal(url.search, '');
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    assert.ok(token?.length === 43);
    return { token, expiresAt: Date.parse(issued.expiresAt) };
  };
  const password = randomBytes(16).toString('hex');
  const accept = (token: string, value = password) => post('users/invite/accept', { token, password: value });

  await t.test('definer helpers revalidate live sessions and ceilings and reject a stored digest as bearer proof', async () => {
    const digest = (cookie: string) => createHmac('sha256', key).update('session\0' + cookie.split('=')[1]).digest('hex');
    const raw = randomBytes(32), id = randomUUID(), email = 'definer-defense@example.test';
    const runtime = <T>(run: (tx: import('../../node_modules/.prisma/control-client/index.js').Prisma.TransactionClient) => Promise<T>) =>
      db.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL ROLE control_runtime`; return run(tx); });
    const issue = (session: string, roleId = support.id, grants = support.grants) => runtime((tx) => tx.$queryRaw<{ expires: Date | null }[]>`
      SELECT control.issue_staff_invite(${id}::uuid, ${email}, ${roleId}::uuid, ${owner.id}::uuid,
        ${createHash('sha256').update(raw).digest()}::bytea, ${grants}::text[], ARRAY[]::text[], ARRAY[]::text[], ${session}) AS expires`);
    assert.deepEqual(await issue('0'.repeat(64)), [{ expires: null }]);
    assert.deepEqual(await issue(digest(supportUser.cookie)), [{ expires: null }]);
    assert.deepEqual(await issue(digest(lesser.cookie), admin.id, admin.grants), [{ expires: null }]);
    assert.deepEqual(await issue(digest(await makeSession(owner.id, 660_000))), [{ expires: null }]);
    assert.ok((await issue(digest(owner.cookie)))[0].expires);
    const verifier = '$2b$12$' + '.'.repeat(53);
    assert.deepEqual(await runtime((tx) => tx.$queryRaw<{ id: string | null }[]>`
      SELECT control.redeem_staff_invite(${createHash('sha256').update(raw).digest()}::bytea, ${verifier}) AS id`), [{ id: null }]);
    assert.equal(await db.staff.count({ where: { email } }), 0);
    assert.deepEqual(await runtime((tx) => tx.$queryRaw<{ changed: boolean }[]>`
      SELECT control.set_staff_enabled(${supportUser.id}::uuid, false, ${digest(supportUser.cookie)}) AS changed`), [{ changed: false }]);
    assert.deepEqual(await runtime((tx) => tx.$queryRaw<{ changed: boolean }[]>`
      SELECT control.set_staff_enabled(${owner.id}::uuid, false, ${digest(lesser.cookie)}) AS changed`), [{ changed: false }]);
  });

  await t.test('staff invitations require permission, recent factor and a bounded database role', async () => {
    const email = 'staff-invite-ceiling@example.test';
    for (const [cookie, status] of [[supportUser.cookie, 403], ['', 401]] as const) {
      assert.equal((await invite(email, support.id, cookie)).status, status);
    }
    assert.equal((await invite(email, support.id, await makeSession(owner.id, 660_000))).status, 403);
    assert.equal((await invite(email, admin.id, lesser.cookie, { removedGrants: ['cc.billing.read', 'cc.billing.manage'] })).status, 403);
    assert.equal((await invite(email, support.id, lesser.cookie, { extraGrants: ['cc.billing.read'] })).status, 403);
    assert.equal((await invite(email, support.id, lesser.cookie, { removedGrants: ['cc.billing.read'] })).status, 403);
    assert.equal((await invite(email, randomUUID())).status, 404);
  });

  await t.test('staff invitation stores only a digest, expires, and redeems once into mandatory TOTP', async () => {
    const email = 'staff-invite-accept@example.test';
    const { token, expiresAt } = await tokenFrom(await invite(email, support.id, owner.cookie,
      { extraGrants: ['cc.portal.read'], removedGrants: ['cc.ticket.reply'] }));
    assert.ok(expiresAt - Date.now() > 71 * 3_600_000 && expiresAt - Date.now() <= 72 * 3_600_000);
    const [stored] = await db.$queryRaw<{ digest: string }[]>`SELECT encode(digest, 'hex') AS digest FROM control.staff_invite WHERE email = ${email}`;
    assert.equal(stored.digest, createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'));
    assert.equal(await db.staff.count({ where: { email } }), 0);
    assert.equal((await accept(token, 'too-short')).status, 400);
    assert.equal((await post('users/invite/accept', { token, password }, '', 'https://other.example.test')).status, 403);
    const redemption = await Promise.all([accept(token), accept(token)]);
    assert.deepEqual(redemption.map((r) => r.status).sort(), [200, 401]);
    const accepted = redemption.find((answer) => answer.status === 200)!;
    assert.equal(accepted.headers.get('set-cookie'), null);
    const enrollment = await accepted.json() as { challenge: string; enrollmentSecret: string };
    assert.equal((await post('session/challenge', { email, password })).status, 401);
    const proof = hotp(base32Decode(enrollment.enrollmentSecret), stepAt(Date.now()));
    assert.equal((await post('session/verify', { challenge: enrollment.challenge, code: proof })).status, 401);
    const enrolled = await post('enrollment', { challenge: enrollment.challenge, code: proof });
    assert.equal(enrolled.status, 200);
    const cookie = enrolled.headers.get('set-cookie')!.split(';', 1)[0];
    const staff = await db.staff.findUniqueOrThrow({ where: { email } });
    assert.equal(staff.roleId, support.id);
    assert.ok(staff.grants.includes('cc.portal.read') && !staff.grants.includes('cc.ticket.reply'));
    assert.equal((await current(cookie)).status, 200);
    assert.equal((await accept(token)).status, 401);
    assert.deepEqual((await db.auditEvent.findMany({ where: { subjectId: staff.id }, orderBy: { sequence: 'asc' } }))
      .map(({ action }) => action), ['staff.invite.issue', 'staff.invite.accept', 'staff.enroll']);

    const expiredEmail = 'staff-invite-expired@example.test';
    const expired = await tokenFrom(await invite(expiredEmail, support.id));
    await db.$executeRaw`UPDATE control.staff_invite SET expires_at = clock_timestamp() - interval '1 minute' WHERE email = ${expiredEmail}`;
    assert.equal((await accept(expired.token)).status, 401);
    assert.equal(await db.staff.count({ where: { email: expiredEmail } }), 0);
  });

  await t.test('staff invitation redemption rechecks the issuing actor and rolls back on audit failure', async () => {
    const retiring = await actor(manager.id, manager.grants);
    const email = 'staff-invite-retired-issuer@example.test';
    const { token } = await tokenFrom(await invite(email, support.id, retiring.cookie));
    assert.equal((await change(retiring.id, 'deactivate')).status, 200);
    assert.equal((await accept(token)).status, 401);
    assert.equal(await db.staff.count({ where: { email } }), 0);

    const rollbackEmail = 'staff-invite-rollback@example.test';
    const rollback = await tokenFrom(await invite(rollbackEmail, support.id));
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT invite_rollback_fixture
      CHECK (action <> 'staff.invite.accept') NOT VALID`;
    try {
      assert.equal((await accept(rollback.token)).status, 500);
      assert.equal(await db.staff.count({ where: { email: rollbackEmail } }), 0);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT invite_rollback_fixture`; }
    assert.equal((await accept(rollback.token)).status, 200);
  });

  await t.test('a pending Admin cannot stand in for a usable Admin during deactivation', async () => {
    await db.staff.update({ where: { id: owner.id }, data: { encryptedSeed: 'fixture-factor-marker' } });
    const pending = await tokenFrom(await invite('pending-admin@example.test', admin.id));
    assert.equal((await accept(pending.token)).status, 200);
    const stillPending = await db.staff.findUniqueOrThrow({ where: { email: 'pending-admin@example.test' } });
    assert.equal(stillPending.encryptedSeed, null);
    const changed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      return tx.$queryRaw<{ changed: boolean }[]>`SELECT control.set_staff_enabled(${owner.id}::uuid, false) AS changed`;
    });
    assert.deepEqual(changed, [{ changed: false }]);
    assert.equal((await current(owner.cookie)).status, 200);
  });

  await t.test('deactivate and reactivate apply the ceiling, preserve the last Admin and invalidate sessions', async () => {
    const peer = await actor(manager.id, manager.grants);
    assert.equal((await change(lesser.id, 'deactivate', lesser.cookie)).status, 403);
    assert.equal((await change(owner.id, 'deactivate', lesser.cookie)).status, 403);
    assert.equal((await change(peer.id, 'deactivate', lesser.cookie)).status, 403);
    assert.equal((await change(owner.id, 'deactivate')).status, 403);
    await db.staff.update({ where: { id: supportUser.id }, data: { challengeDigest: '1'.repeat(64),
      challengeExpiresAt: new Date(Date.now() + 4 * 60_000), pendingSeed: 'fixture-factor-marker' } });
    assert.equal((await change(supportUser.id, 'deactivate')).status, 200);
    const dropped = await db.staff.findUniqueOrThrow({ where: { id: supportUser.id } });
    assert.deepEqual([dropped.challengeDigest, dropped.challengeExpiresAt, dropped.pendingSeed], [null, null, null]);
    assert.equal((await current(supportUser.cookie)).status, 401);
    assert.equal(await db.staffSession.count({ where: { staffId: supportUser.id } }), 0);
    assert.equal((await change(supportUser.id, 'activate')).status, 200);
    assert.equal((await current(supportUser.cookie)).status, 401);
    assert.equal((await current(await makeSession(supportUser.id))).status, 200);
    assert.deepEqual((await db.auditEvent.findMany({ where: { subjectId: supportUser.id }, orderBy: { sequence: 'asc' } }))
      .map(({ action }) => action), ['staff.deactivate', 'staff.reactivate']);
  });
}
