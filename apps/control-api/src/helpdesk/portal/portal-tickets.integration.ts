import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { portalDigest } from '../../portal/portal-identity-policy.js';
import { captureAuditCheckpoint, verifyAuditCheckpoint } from '../../audit/audit.js';

type Ticket = { id: string; subject: string };
type Thread = { messages: { items: { id: string; text: string }[] } };

export async function portalTicketCases(t: TestContext, db: PrismaClient, root: string, origin: string, key: string) {
  const business = () => db.business.create({ data: { id: randomUUID(), legalName: 'Support fixture', displayName: 'Support fixture' } });
  const [a, b] = await Promise.all([business(), business()]);
  async function portal(businessId: string) {
    const accountId = randomUUID(), token = randomBytes(32).toString('base64url');
    const outlet = await db.outlet.create({ data: { id: randomUUID(), businessId, displayName: 'Fixture', timeZone: 'UTC' } });
    await db.$executeRaw`INSERT INTO control.portal_account(id,business_id,email,status,password_hash)
      VALUES (${accountId}::uuid,${businessId}::uuid,${accountId + '@example.test'},'active','fixture')`;
    await db.$executeRaw`INSERT INTO control.portal_session(digest,account_id,expires_at)
      VALUES (${portalDigest(key,'session',token)},${accountId}::uuid,clock_timestamp()+interval '10 minutes')`;
    return { accountId, businessId, outletId: outlet.id, cookie: '__Host-control_portal=' + token };
  }
  async function staff(grants: string[]) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'fixture' } });
    const digest = createHmac('sha256','a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  }
  const [opener, sameBusinessOtherAccount, differentBusiness, reader, writer] = await Promise.all([
    portal(a.id), portal(a.id), portal(b.id), staff(['cc.ticket.read']), staff(['cc.ticket.read','cc.ticket.manage','cc.ticket.reply']),
  ]);
  const inboxReader = reader.cookie, replier = writer.cookie;
  const req = (route: string, cookie = opener.cookie, body?: object, from = origin, method = body ? 'POST' : 'GET') =>
    fetch(new URL(route.slice(1), root), {
      method, headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const draft = { subject: 'Portal printer check', text: 'Please check the printer. <b>Thanks</b>', requestKey: randomUUID() };
  let id = '';
  const portalPath = () => '/portal/tickets/' + id;
  const staffPath = () => '/tickets/' + id;

  await t.test('opens an own-account ticket exactly once and adds one scoped audit event', async () => {
    const route = '/portal/tickets', body = { ...draft, outletId: opener.outletId };
    assert.equal((await req(route, opener.cookie, { ...body, outletId: differentBusiness.outletId })).status, 400);
    assert.equal((await req(route, opener.cookie, { ...body, businessId: differentBusiness.businessId })).status, 400);
    assert.equal((await req(route, inboxReader, body)).status, 401);
    assert.equal((await req(route, opener.cookie, body, 'https://foreign.example.test')).status, 403);
    const [a, b] = await Promise.all([req(route, opener.cookie, body), req(route, opener.cookie, body)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    const first = await a.json() as { id: string };
    id = first.id;
    assert.deepEqual(await b.json(), first);
    assert.equal((await req(route, opener.cookie, { ...body, text: 'Different text' })).status, 409);
    const event = await db.auditEvent.findMany({ where: { subjectId: id, requestId: draft.requestKey } });
    assert.equal(event.length, 1);
    assert.equal(event[0].actorType, 'customer');
    assert.equal(event[0].actorId, opener.accountId);
    assert.equal(event[0].businessId, opener.businessId);
    assert.equal(await db.ticketMessage.count({ where: { ticketId: id } }), 1);
    assert.ok(await verifyAuditCheckpoint(db, await captureAuditCheckpoint(db)));
  });

  await t.test('scopes detail and queue to the opener, including other customers in the same business', async () => {
    assert.ok(id);
    const yours = await req(portalPath());
    assert.equal(yours.status, 200);
    assert.equal(yours.headers.get('cache-control'), 'no-store');
    assert.equal((await yours.json() as Thread).messages.items[0].text, draft.text);
    const second = await req('/portal/tickets', opener.cookie, { ...draft, requestKey: randomUUID() });
    assert.equal(second.status, 201);
    const list = '/portal/tickets?limit=1';
    type Page = { items: Ticket[]; nextCursor: string | null };
    const firstPage = await (await req(list)).json() as Page;
    assert.ok(firstPage.nextCursor);
    const lastPage = await (await req(list + '&cursor=' + firstPage.nextCursor)).json() as Page;
    assert.equal(lastPage.nextCursor, null);
    assert.deepEqual([firstPage.items[0].id, lastPage.items[0].id].sort(),
      [id, (await second.json() as { id: string }).id].sort());
    for (const actor of [differentBusiness, sameBusinessOtherAccount]) {
      assert.equal((await req(portalPath(), actor.cookie)).status, 404);
      const page = await (await req('/portal/tickets', actor.cookie)).json() as { items: Ticket[] };
      assert.equal(page.items.some((ticket) => ticket.id === id), false);
    }
    const staff = await (await req('/tickets?businessId=' + opener.businessId, inboxReader)).json() as { items: Ticket[] };
    assert.ok(staff.items.some((ticket) => ticket.id === id));
    for (const change of [{ businessId: differentBusiness.businessId }, { outletId: sameBusinessOtherAccount.outletId }]) {
      assert.equal((await req(staffPath(), replier, change, origin, 'PATCH')).status, 409);
    }
    assert.deepEqual(await (await req(staffPath(), inboxReader)).json().then((row: unknown) => {
      const { scopeLocked, replyChannel } = row as { scopeLocked: boolean; replyChannel: string | null };
      return { scopeLocked, replyChannel };
    }), { scopeLocked: true, replyChannel: null });
    assert.equal((await (await req(staffPath(), replier)).json() as { replyChannel: string }).replyChannel, 'portal');
    const unrelated = await db.ticket.create({ data: { id: randomUUID(), subject: 'Unshared email', businessId: opener.businessId } });
    const mail = await db.ticketMessage.create({ data: { id: randomUUID(), ticketId: unrelated.id,
      sequence: 1, direction: 'inbound', visibility: 'public', text: 'Unshared fixture mail' } });
    const mailbox = 'portal-scope@example.test';
    await db.mailboxCursor.create({ data: { mailbox } });
    await db.inboundReceipt.create({ data: { mailbox, providerId: 'synthetic-mail', messageRowId: mail.id,
      claimedSender: 'portal-scope@example.test', outcome: 'accept', reason: 'triage' } });
    assert.equal((await req('/portal/tickets/' + unrelated.id)).status, 404);
    await assert.rejects(db.ticket.update({ where: { id }, data: { businessId: differentBusiness.businessId, outletId: null } }));
  });

  await t.test('delivers a staff reply through the portal and preserves the private note boundary', async () => {
    assert.ok(id);
    const note = { text: 'Private fixture note', requestKey: randomUUID() };
    const reply = { text: 'Public fixture reply', requestKey: randomUUID() };
    const target = staffPath() + '/portal-replies';
    const unanswered = async () => (await (await req(
      '/tickets?businessId=' + opener.businessId + '&sort=oldest-unanswered', inboxReader,
    )).json() as { items: Ticket[] }).items.some((ticket) => ticket.id === id);
    assert.equal((await req(staffPath() + '/notes', replier, note)).status, 201);
    assert.equal(await unanswered(), true);
    assert.equal((await req(target, inboxReader, reply)).status, 403);
    assert.equal((await req(target, opener.cookie, reply)).status, 401);
    assert.equal((await req(target, replier, { ...reply, recipient: 'other@example.test' })).status, 400);
    const [a, b] = await Promise.all([req(target, replier, reply), req(target, replier, reply)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    const sent = await a.json() as { id: string };
    assert.deepEqual(await b.json(), sent);
    assert.equal((await req(target, replier, { ...reply, text: 'Changed retry' })).status, 409);
    assert.equal(await db.ticketReplyOutbox.count({ where: { message: { ticketId: id } } }), 0);
    assert.equal(await db.auditEvent.count({ where: { subjectId: id, requestId: reply.requestKey } }), 1);
    assert.equal(await unanswered(), false);
    assert.deepEqual((await (await req(portalPath())).json() as Thread).messages.items.map(({ text }) => text), [draft.text, reply.text]);
    const page = await (await req(portalPath() + '?limit=1')).json() as { messages: { nextCursor: number } };
    assert.equal(page.messages.nextCursor, 1);
    const remaining = await (await req(portalPath() + '?cursor=1&limit=1')).json() as Thread;
    assert.deepEqual(remaining.messages.items.map(({ text }) => text), [reply.text]);
    assert.ok((await (await req(staffPath(), inboxReader)).json() as Thread).messages.items.some(({ text }) => text === note.text));
  });

  await t.test('requires active hosted access for portal ticket reads and writes', async () => {
    assert.ok(id);
    async function setAccess(status: string, revision: number) {
      await db.$executeRaw`INSERT INTO control.hosted_access_event(business_id,request_key,actor_id,status,reason,revision)
        VALUES (${opener.businessId}::uuid,${randomUUID()}::uuid,${writer.id}::uuid,${status},'Fixture transition',${revision})`;
    }
    const other = await req('/portal/tickets', differentBusiness.cookie, draft);
    assert.equal(other.status, 201);
    const { id: foreign } = await other.json() as { id: string };
    assert.notEqual(foreign, id);
    await setAccess('suspended', 1);
    try {
      assert.equal((await req('/portal/tickets')).status, 403);
      assert.equal((await req(portalPath())).status, 403);
      assert.equal((await req('/portal/tickets/' + foreign)).status, 404);
      assert.equal((await req('/portal/tickets/' + randomUUID())).status, 404);
      assert.equal((await req('/portal/tickets', opener.cookie, { ...draft, requestKey: randomUUID() })).status, 403);
      assert.equal((await req(staffPath(), inboxReader)).status, 200);
    } finally {
      await setAccess('active', 2);
    }
  });

  await t.test('answers unauthenticated portal and staff-reply requests with 401', async () => {
    assert.ok(id);
    for (const [route, body] of [['/portal/tickets', undefined], [portalPath(), undefined], ['/portal/tickets', draft],
      [staffPath() + '/portal-replies', { text: 'Anonymous', requestKey: randomUUID() }]] as const) {
      assert.equal((await req(route, '', body as object | undefined)).status, 401, route);
    }
  });

  await t.test('bounds customer text and never creates a ticket for a forged business', async () => {
    const before = await db.ticket.count({ where: { businessId: differentBusiness.businessId } });
    const route = '/portal/tickets';
    const fresh = () => ({ ...draft, requestKey: randomUUID() });
    for (const bad of [{ text: 'a'.repeat(4001) }, { subject: 'a'.repeat(241) }, { text: '   ' }, { text: 'a\u0000b' }]) {
      assert.equal((await req(route, opener.cookie, { ...fresh(), ...bad })).status, 400);
    }
    assert.equal((await req(route, opener.cookie, { ...fresh(), text: 'a'.repeat(4000) })).status, 201);
    assert.equal((await req(route, opener.cookie, { ...fresh(), businessId: differentBusiness.businessId })).status, 400);
    assert.equal(await db.ticket.count({ where: { businessId: differentBusiness.businessId } }), before);
    assert.equal((await req('/portal/tickets/' + randomUUID())).status, 404);
  });

  await t.test('rate-limits new customer tickets per account without counting idempotent replays', async () => {
    const busy = await portal(a.id), calm = await portal(a.id);
    const open = (cookie: string, requestKey: string) => req('/portal/tickets', cookie, { ...draft, requestKey });
    const keys = Array.from({ length: 10 }, () => randomUUID());
    for (const key of keys) assert.equal((await open(busy.cookie, key)).status, 201);
    const audits = () => db.auditEvent.count({ where: { actorId: busy.accountId } });
    assert.equal(await audits(), 10);
    assert.equal((await open(busy.cookie, keys[0])).status, 201);
    const limited = await open(busy.cookie, randomUUID());
    assert.equal(limited.status, 429);
    assert.equal(await audits(), 10);
    assert.equal((await open(calm.cookie, randomUUID())).status, 201);
    assert.equal((await req('/portal/tickets', busy.cookie)).status, 200);
  });

  await t.test('restricts portal database grants and customer audit authoring', async () => {
    const denied = (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === '42501';
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_portal_runtime`;
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_ticket_header`, []);
      await tx.$queryRaw`SELECT set_config('control.portal_business_id', ${opener.businessId}, true),
        set_config('control.portal_account_id', ${sameBusinessOtherAccount.accountId}, true)`;
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_ticket_header WHERE id=${id}::uuid`, []);
    });
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_portal_runtime`;
      return tx.$queryRaw`SELECT id FROM control.ticket`;
    }), denied);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      return tx.$queryRaw`SELECT control.append_audit_event('customer', ${opener.accountId}::uuid, ${opener.businessId}::uuid,
        'portal.ticket.open', 'ticket', ${id}::uuid, ${randomUUID()}::uuid, 'succeeded', ARRAY['ticket'])`;
    }), denied);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      return tx.$queryRaw`SELECT control.append_audit_event_core('customer', ${opener.accountId}::uuid, ${opener.businessId}::uuid,
        'portal.ticket.open', 'ticket', ${id}::uuid, ${randomUUID()}::uuid, 'succeeded', ARRAY['ticket'])`;
    }), denied);
  });
}
