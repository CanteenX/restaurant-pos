import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

type Principal = { accountId: string; businessId: string; cookie: string; outletId: string };
type Fixtures = {
  root: string;
  origin: string;
  opener: Principal;
  sameBusinessOtherAccount: Principal;
  differentBusiness: Principal;
  inboxReader: string;
  replier: string;
  setSuspended: (businessId: string, suspended: boolean) => Promise<void>;
};
type Ticket = { id: string; subject: string };
type Thread = { messages: { items: { id: string; text: string }[] } };

export async function portalTicketCases(t: TestContext, db: PrismaClient, fixture: Fixtures) {
  const { root, origin, opener, sameBusinessOtherAccount, differentBusiness, inboxReader, replier } = fixture;
  const req = (route: string, cookie = opener.cookie, body?: object, from = origin) => fetch(root + route, {
    method: body ? 'POST' : 'GET', headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body),
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
  });

  await t.test('scopes detail and queue to the opener, including other customers in the same business', async () => {
    assert.ok(id);
    const yours = await req(portalPath());
    assert.equal(yours.status, 200);
    assert.equal(yours.headers.get('cache-control'), 'no-store');
    assert.equal((await yours.json() as Thread).messages.items[0].text, draft.text);
    for (const actor of [differentBusiness, sameBusinessOtherAccount]) {
      assert.equal((await req(portalPath(), actor.cookie)).status, 404);
      const page = await (await req('/portal/tickets', actor.cookie)).json() as { items: Ticket[] };
      assert.equal(page.items.some((ticket) => ticket.id === id), false);
    }
    const staff = await (await req('/tickets?businessId=' + opener.businessId, inboxReader)).json() as { items: Ticket[] };
    assert.ok(staff.items.some((ticket) => ticket.id === id));
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
    assert.ok((await (await req(staffPath(), inboxReader)).json() as Thread).messages.items.some(({ text }) => text === note.text));
  });

  await t.test('requires active hosted access for portal ticket reads and writes', async () => {
    assert.ok(id);
    await fixture.setSuspended(opener.businessId, true);
    try {
      assert.equal((await req('/portal/tickets')).status, 403);
      assert.equal((await req(portalPath())).status, 403);
      assert.equal((await req('/portal/tickets', opener.cookie, { ...draft, requestKey: randomUUID() })).status, 403);
      assert.equal((await req(staffPath(), inboxReader)).status, 200);
    } finally {
      await fixture.setSuspended(opener.businessId, false);
    }
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
  });
}
