import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

type Reply = { id: string; direction: string; visibility: string; text: string; deliveryState: string };
type Detail = { replyTarget: { address: string; verified: boolean } | null; messages: { items: Reply[] } };

export async function replyCases(t: TestContext, db: PrismaClient, url: string, origin: string) {
  const actor = async (grants: string[]) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  };
  const grants = ['cc.ticket.read', 'cc.ticket.reply'];
  const [reader, replier, other] = await Promise.all([actor(['cc.ticket.read']), actor(grants), actor(grants)]);
  const mailbox = 'synthetic-reply@example.test', claimed = 'Original.Manager@example.test', rfc = '<origin@example.test>';
  await db.mailboxCursor.create({ data: { mailbox } });

  const incoming = async (ticketId: string, sequence: number, address: string | null, verified: boolean) => {
    const id = randomUUID();
    await db.ticketMessage.create({ data: { id, ticketId, sequence, text: 'Synthetic incoming',
      direction: 'inbound', visibility: 'public' } });
    await db.$executeRaw`INSERT INTO control.inbound_receipt
      (mailbox, provider_id, outcome, reason, message_row_id, rfc_message_id, claimed_sender, verified_sender)
      VALUES (${mailbox}, ${id}, 'accept', 'triage', ${id}::uuid, ${rfc}, ${address}, ${verified ? address : null})`;
  };
  const seed = async (address: string | null = claimed, verified = false) => {
    const id = randomUUID();
    await db.ticket.create({ data: { id, subject: 'Printer\u2028check' } });
    await incoming(id, 1, address, verified);
    return id;
  };
  const request = (path: string, cookie: string, body?: object, from = origin) => fetch(url + '/' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie, origin: from, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const reply = (id: string, body: object, cookie = replier.cookie, from = origin) =>
    request(id + '/messages', cookie, body, from);
  const detail = async (id: string, cookie = replier.cookie) => (await (await request(id, cookie)).json()) as Detail;
  const draft = () => ({ text: 'Please restart the printer. <b>Thanks</b>', requestKey: randomUUID() });

  await t.test('permits only reply-granted staff and never takes an address from a request or later sender', async () => {
    const id = await seed(), body = draft();
    await incoming(id, 2, 'later@example.test', true);
    assert.deepEqual((await detail(id)).replyTarget, { address: claimed, verified: false });
    assert.equal((await detail(id, reader.cookie)).replyTarget, null);
    assert.equal((await reply(id, body, '')).status, 401);
    assert.equal((await reply(id, body, reader.cookie)).status, 403);
    assert.equal((await reply(id, { ...body, recipient: 'elsewhere@example.test' })).status, 400);
    assert.equal((await reply(id, body)).status, 403);
    assert.equal((await reply(id, { ...body, acknowledgeUnverified: true }, replier.cookie, 'https://other.example.test')).status, 403);
    const noOrigin = await seed(null);
    await incoming(noOrigin, 2, 'later@example.test', true);
    assert.equal((await detail(noOrigin)).replyTarget, null);
    assert.equal((await reply(noOrigin, { ...draft(), acknowledgeUnverified: true })).status, 409);
    assert.equal(await db.ticketMessage.count({ where: { ticketId: id, direction: 'outbound' } }), 0);
  });

  await t.test('queues one public reply, snapshot and audit across same-key retries', async () => {
    const id = await seed(), body = { ...draft(), acknowledgeUnverified: true };
    await incoming(id, 2, 'later@example.test', true);
    const noteKey = randomUUID();
    await db.ticketMessage.create({ data: { id: randomUUID(), ticketId: id, sequence: 3,
      requestKey: noteKey, authorId: reader.id, text: 'Private technician notes' } });
    assert.equal((await reply(id, { ...body, requestKey: noteKey })).status, 409);
    const responses = await Promise.all([reply(id, body), reply(id, body, other.cookie)]);
    assert.deepEqual(responses.map((res) => res.status), [201, 201]);
    const queued = (await responses[0].json()) as Reply;
    assert.deepEqual(await responses[1].json(), queued);
    assert.deepEqual([queued.direction, queued.visibility, queued.deliveryState, queued.text],
      ['outbound', 'public', 'queued', body.text]);
    assert.deepEqual(Object.keys(queued).sort(), ['authorId', 'createdAt', 'deliveryState', 'direction', 'id', 'sequence', 'text', 'visibility']);
    assert.equal((await reply(id, { ...body, text: 'Changed reply' })).status, 409);
    assert.equal((await reply(id, { text: body.text, requestKey: body.requestKey })).status, 409);
    const visible = await detail(id, reader.cookie);
    assert.equal(visible.replyTarget, null);
    assert.deepEqual(visible.messages.items.filter((message) => message.direction === 'outbound'), [queued]);
    const rows = await db.$queryRaw<{ recipient: string; subject: string; message_id: string; in_reply_to: string;
      rendered_text: string; rendered_html: string; acknowledged_unverified: boolean }[]>`
      SELECT recipient, subject, message_id, in_reply_to, rendered_text, rendered_html, acknowledged_unverified
      FROM control.ticket_reply_outbox WHERE message_row_id = ${queued.id}::uuid`;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].recipient, rows[0].subject, rows[0].message_id, rows[0].in_reply_to, rows[0].acknowledged_unverified],
      [claimed, 'Re: Printer check', '<' + queued.id + '@nventra.invalid>', rfc, true]);
    assert.ok(rows[0].rendered_text.includes(body.text));
    assert.ok(rows[0].rendered_html.includes('&lt;b&gt;Thanks&lt;/b&gt;'));
    assert.ok(!rows[0].rendered_text.includes('Private technician notes'));
    assert.ok(!rows[0].rendered_html.includes('Private technician notes'));
    const audit = await db.auditEvent.findMany({ where: { requestId: body.requestKey } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'ticket.reply.queue');
    assert.equal(audit[0].subjectId, id);
  });

  await t.test('rolls back a verified reply and its outbox if the audit cannot append', async () => {
    const id = await seed(claimed, true), body = draft();
    assert.deepEqual((await detail(id)).replyTarget, { address: claimed, verified: true });
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT fixture_reply_audit_failure
      CHECK (action <> 'ticket.reply.queue') NOT VALID`;
    try {
      assert.equal((await reply(id, body)).status, 500);
      assert.equal(await db.ticketMessage.count({ where: { ticketId: id, direction: 'outbound' } }), 0);
      assert.equal(await db.auditEvent.count({ where: { requestId: body.requestKey } }), 0);
    } finally {
      await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT fixture_reply_audit_failure`;
    }
    assert.equal((await reply(id, body)).status, 201);
  });
}