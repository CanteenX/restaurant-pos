import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Prisma, PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

export async function ticketCases(t: TestContext, db: PrismaClient, url: string, origin: string) {
  const actor = async (grants: string[]) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  };
  const reader = await actor(['cc.ticket.read']), writer = await actor(['cc.ticket.manage']);
  const other = await actor(['cc.ticket.manage']), replyOnly = await actor(['cc.ticket.reply']);
  const req = (path = '', cookie = reader.cookie, method = 'GET', body?: unknown, from = origin) =>
    fetch(url + path, { method, headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const seed = async () => {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO control.ticket (id, subject) VALUES (${id}::uuid, 'Synthetic ticket')`;
    return '/' + id;
  };
  const patch = (path: string, data: object, cookie = writer.cookie) => req(path, cookie, 'PATCH', data);
  const note = (path: string, data: object, cookie = writer.cookie) => req(path + '/notes', cookie, 'POST', data);

  await t.test('requires the exact staff permission and cookie, and pages only safe ticket previews', async () => {
    assert.equal((await req('', '')).status, 401);
    assert.equal((await req('', reader.cookie.replace('__Host-control_staff', 'portal'))).status, 401);
    assert.equal((await req('', writer.cookie)).status, 403);
    const path = await seed();
    await seed();
    assert.equal((await patch(path, { status: 'resolved' }, reader.cookie)).status, 403);
    assert.equal((await note(path, { requestKey: randomUUID(), text: 'internal' }, replyOnly.cookie)).status, 403);
    assert.equal((await req(path, writer.cookie, 'PATCH', { status: 'resolved' }, 'https://wrong.example.test')).status, 403);
    assert.equal((await req('/invalid')).status, 400);
    assert.equal((await req('/' + randomUUID())).status, 404);
    assert.equal((await req('?limit=0')).status, 400);
    const response = await req('?limit=1');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json() as { items: { id: string; businessId: null; outletId: null }[]; nextCursor: string };
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].businessId, null);
    assert.equal(first.items[0].outletId, null);
    assert.equal('messages' in first.items[0], false);
    const second = await (await req('?cursor=' + first.nextCursor)).json() as typeof first;
    assert.notEqual(second.items[0].id, first.items[0].id);
    assert.deepEqual((await (await req('?status=closed')).json() as typeof first).items, []);
  });

  await t.test('triages an unassigned ticket under composite scope and does not audit concurrent no-ops', async () => {
    const path = await seed(), id = path.slice(1);
    const business = () => db.business.create({ data: { id: randomUUID(), legalName: 'Helpdesk', displayName: 'Fixture' } });
    const [a, b] = await Promise.all([business(), business()]);
    const outlet = await db.outlet.create({ data: { id: randomUUID(), businessId: a.id, displayName: 'Fixture', timeZone: 'UTC' } });
    assert.equal((await patch(path, { businessId: b.id, outletId: outlet.id })).status, 400);
    assert.equal((await patch(path, { outletId: outlet.id })).status, 400);
    const change = { businessId: a.id, outletId: outlet.id, status: 'pending', priority: 'high' };
    const assigned = await Promise.all([patch(path, change), patch(path, change, other.cookie)]);
    assert.deepEqual(assigned.map((res) => res.status), [200, 200]);
    assert.deepEqual(await assigned[0].json(), await assigned[1].json());
    const audit = await db.auditEvent.findMany({ where: { subjectId: id } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].businessId, a.id);
    assert.equal(audit[0].action, 'ticket.status.pending');
    assert.deepEqual(audit[0].changedFields.sort(), ['businessId', 'outletId', 'priority', 'status']);
    assert.equal((await patch(path, { ownerId: replyOnly.id })).status, 400);
    const reassigned = await patch(path, { businessId: b.id, ownerId: reader.id });
    assert.equal(reassigned.status, 200);
    assert.deepEqual(await reassigned.json(), { id });
    const detail = await (await req(path)).json() as { outletId: unknown; ownerId: unknown };
    assert.equal(detail.outletId, null);
    assert.equal(detail.ownerId, reader.id);
    assert.equal((await patch(path, { ownerId: null })).status, 200);
    const scope = (e: unknown) => (e as { meta?: { code?: string } }).meta?.code === '23503';
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$executeRaw`UPDATE control.ticket SET outlet_id = ${outlet.id}::uuid WHERE id = ${id}::uuid`;
    }), scope);
  });

  await t.test('rejects empty patches and returns only the ticket identifier to manage-only staff', async () => {
    const path = await seed(), id = path.slice(1);
    const empty = await patch(path, {});
    const noChange = await patch(path, { status: 'open' });
    const result: unknown = await noChange.json();
    assert.deepEqual({ emptyStatus: empty.status, status: noChange.status, result },
      { emptyStatus: 400, status: 200, result: { id } });
    assert.equal(await db.auditEvent.count({ where: { subjectId: id } }), 0);
  });

  await t.test('rechecks an owner after a concurrent grant revocation releases the staff row', async () => {
    const path = await seed(), owner = await actor(['cc.ticket.read']);
    let pending: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM control.staff WHERE id = ${owner.id}::uuid FOR UPDATE`;
      await tx.staff.update({ where: { id: owner.id }, data: { grants: [] } });
      pending = patch(path, { ownerId: owner.id });
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(blocked, true);
    }, { timeout: 10_000 });
    assert.equal((await pending)?.status, 400);
    const detail = await (await req(path)).json() as { ownerId: unknown };
    assert.equal(detail.ownerId, null);
    assert.equal(await db.auditEvent.count({ where: { subjectId: path.slice(1) } }), 0);
  });

  await t.test('stores literal staff notes exactly once, omits them from previews and rejects forged metadata', async () => {
    const path = await seed(), id = path.slice(1), input = { requestKey: randomUUID(), text: '<b>internal only</b>\nLine two.' };
    assert.equal((await note(path, { ...input, visibility: 'public' })).status, 400);
    assert.equal((await note(path, { ...input, text: 't'.repeat(4001) })).status, 400);
    const results = await Promise.all([note(path, input), note(path, input, other.cookie)]);
    assert.deepEqual(results.map((result) => result.status), [201, 201]);
    const first = await results[0].json() as { text: string; visibility: string; id: string };
    assert.deepEqual(first, await results[1].json());
    assert.equal(first.text, input.text);
    assert.equal(first.visibility, 'staff');
    assert.equal('requestKey' in first, false);
    assert.equal((await note(path, { ...input, text: 'changed' })).status, 409);
    assert.equal((await note(path, { ...input, requestKey: randomUUID() })).status, 201);
    const detail = await (await req(path + '?limit=1')).json() as { messages: { items: { id: string }[]; nextCursor: number } };
    assert.deepEqual(detail.messages.items.map((message) => message.id), [first.id]);
    assert.equal(detail.messages.nextCursor, 1);
    const next = await (await req(path + '?cursor=1')).json() as typeof detail;
    assert.equal(next.messages.items.length, 1);
    assert.notEqual(next.messages.items[0].id, first.id);
    assert.equal(next.messages.nextCursor, null);
    assert.equal((await req(path, replyOnly.cookie)).status, 403);
    assert.equal(await db.auditEvent.count({ where: { subjectId: id, requestId: input.requestKey } }), 1);
  });

  await t.test('rolls back ticket and note mutations on audit failure and denies runtime message rewrites', async () => {
    const path = await seed(), id = path.slice(1);
    const input = { requestKey: randomUUID(), text: 'discard on failure' };
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_ticket_failure CHECK (subject_type <> 'ticket') NOT VALID`;
    try {
      assert.equal((await patch(path, { status: 'resolved' })).status, 500);
      assert.equal((await note(path, input)).status, 500);
      const detail = await (await req(path)).json() as { status: string; messages: { items: unknown[] } };
      assert.equal(detail.status, 'open');
      assert.deepEqual(detail.messages.items, []);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_ticket_failure`; }
    assert.equal((await note(path, input)).status, 201);
    const denied = (e: unknown) => (e as { meta?: { code?: string } }).meta?.code === '42501';
    const runtime = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
        return work(tx);
      });
    await assert.rejects(runtime((tx) => tx.$executeRaw`UPDATE control.ticket_message SET text = 'rewritten' WHERE ticket_id = ${id}::uuid`), denied);
    await assert.rejects(runtime((tx) => tx.$executeRaw`INSERT INTO control.ticket_message
      (id, ticket_id, sequence, request_key, author_id, text, visibility)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, 9, ${randomUUID()}::uuid, ${writer.id}::uuid, 'fixture', 'staff')`), denied);
  });
}
