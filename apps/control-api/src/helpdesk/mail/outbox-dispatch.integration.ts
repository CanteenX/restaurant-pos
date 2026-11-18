import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Prisma, PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { dispatchOutbox } from './outbox-dispatch.js';

export async function outboxCases(t: TestContext, db: PrismaClient, worker: PrismaClient) {
  const signal = new AbortController().signal, ticket = randomUUID(), parent = randomUUID(), author = randomUUID();
  const runtime = <T>(op: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE control_runtime`; return op(tx);
  });
  const enqueue = (tx: Prisma.TransactionClient, id: string, ack = true, parentId = parent) =>
    tx.$executeRaw`SELECT control.enqueue_ticket_reply(${id}::uuid,${ticket}::uuid,${parentId}::uuid,${author}::uuid,
      ${randomUUID()}::uuid,'Plain reply',${'<' + id + '@nventra.invalid>'},'Support','Rendered text','<p>Rendered text</p>',${ack})`;
  const queue = async () => { const id = randomUUID(); await runtime((tx) => enqueue(tx,id)); return id; };
  const state = async (id: string) => (await db.$queryRaw<{ state: string; attempts: number }[]>`
    SELECT state,attempts FROM control.ticket_reply_outbox WHERE message_row_id = ${id}::uuid`)[0];
  const quota = async () => (await db.$queryRaw<{ attempts: number }[]>`SELECT attempts FROM control.outbox_daily_quota
    WHERE day = (clock_timestamp() AT TIME ZONE 'UTC')::date`)[0]?.attempts ?? 0;
  const denied = (err: unknown) => (err as { meta?: { code?: string } }).meta?.code === '42501';
  await t.test('installs the durable queue and allows only scoped database operations', async () => {
    const [installed] = await db.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('control.ticket_reply_outbox') IS NOT NULL AS present`;
    assert.equal(installed.present, true);
    const functions = await db.$queryRaw<{ fixed: boolean; unauthorized: boolean }[]>`SELECT
      (p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']) AS fixed,
      has_function_privilege('control_audit_ungranted',p.oid,'EXECUTE') AS unauthorized
      FROM pg_proc p WHERE p.pronamespace='control'::regnamespace AND p.proname IN ('enqueue_ticket_reply','claim_ticket_reply','finish_ticket_reply')`;
    assert.deepEqual(functions, Array(3).fill({ fixed: true, unauthorized: false }));
    await assert.rejects(worker.$queryRaw`SELECT text FROM control.ticket_message`, denied);
    await assert.rejects(worker.$queryRaw`SELECT password_hash FROM control.staff`, denied);
    await assert.rejects(worker.$executeRaw`UPDATE control.outbox_daily_quota SET attempts=0`, denied);
    await assert.rejects(worker.$queryRaw`SELECT recipient FROM control.ticket_reply_outbox`, denied);
    await assert.rejects(runtime(tx => tx.$queryRaw`SELECT rendered_text FROM control.ticket_reply_outbox`), denied);
    await assert.rejects(runtime(tx => tx.$queryRaw`SELECT * FROM control.claim_ticket_reply()`), denied);
    await runtime(tx => tx.$queryRaw`SELECT message_row_id,state,acknowledged_unverified FROM control.ticket_reply_outbox`);
  });
  await db.ticket.create({ data: { id: ticket, subject: 'Synthetic outbox' } });
  await db.staff.create({ data: { id: author, email: 'outbox-staff@example.test', passwordHash: 'inert' } });
  await db.ticketMessage.create({ data: { id: parent, ticketId: ticket, sequence: 1, direction: 'inbound', visibility: 'public', text: 'Inbound' } });
  await db.mailboxCursor.create({ data: { mailbox: 'outbox@example.test' } });
  await db.$executeRaw`INSERT INTO control.inbound_receipt(mailbox,provider_id,outcome,reason,message_row_id,claimed_sender,rfc_message_id)
    VALUES ('outbox@example.test','original','accept','triage',${parent}::uuid,'member@example.test','<parent@example.test>')`;
  await t.test('validates enqueue source, acknowledgment and caller transaction rollback', async () => {
    const id = randomUUID();
    await assert.rejects(runtime(tx => enqueue(tx,id,false)));
    await assert.rejects(runtime(tx => enqueue(tx,id,true,randomUUID())));
    await assert.rejects(enqueue(worker,id), denied);
    await assert.rejects(runtime(async tx => { await enqueue(tx,id); throw new Error('rollback'); }), /rollback/);
    assert.equal(await state(id), undefined);
    assert.equal(await db.ticketMessage.count({ where: { id } }), 0);
  });
  await t.test('reserves once, commits before SMTP, and preserves immutable envelope on retry', async () => {
    const id = await queue(), messageId = '<' + id + '@nventra.invalid>';
    await assert.rejects(worker.$transaction(async tx => {
      await tx.$queryRaw`SELECT * FROM control.claim_ticket_reply()`;
      throw new Error('discard reservation');
    }), /discard reservation/);
    assert.deepEqual(await state(id), { state: 'queued', attempts: 0 });
    assert.equal(await quota(), 0);
    assert.equal(await dispatchOutbox(worker,{ send: () => { throw new Error('unexpected'); } },AbortSignal.abort()), 'idle');
    let calls = 0;
    const send = async (msg: { to: string; messageId: string; inReplyTo?: string }) => {
      assert.deepEqual(msg, { to: 'member@example.test', subject: 'Support', messageId, inReplyTo: '<parent@example.test>',
        text: 'Rendered text', html: '<p>Rendered text</p>' });
      assert.deepEqual(await state(id), { state: 'sending', attempts: ++calls });
      assert.equal(await quota(), calls);
      return calls === 1 ? { status: 'rejected', responseCode: 451, retryable: true } as const : { status: 'sent', messageId } as const;
    };
    const pair = await Promise.all([dispatchOutbox(worker,{ send },signal),dispatchOutbox(worker,{ send },signal)]);
    assert.deepEqual(pair.sort(), ['idle','queued']);
    assert.equal(await dispatchOutbox(worker,{ send },signal), 'idle');
    await db.$executeRaw`UPDATE control.ticket_reply_outbox SET available_at=now() WHERE message_row_id=${id}::uuid`;
    assert.equal(await dispatchOutbox(worker,{ send },signal), 'sent');
    assert.deepEqual(await state(id), { state: 'sent', attempts: 2 });
  });
  await t.test('holds cancelled, ambiguous and expired sends; a stale token cannot finish', async () => {
    const id = await queue(), cancel = new AbortController();
    assert.equal(await dispatchOutbox(worker,{ send: () => {
      cancel.abort(); return new Promise(() => undefined);
    } },cancel.signal), 'held');
    assert.deepEqual(await state(id), { state: 'held', attempts: 1 });
    const next = await queue();
    assert.equal(await dispatchOutbox(worker,{ send: () => Promise.reject(new Error('synthetic network')) },signal), 'held');
    assert.equal((await state(next)).state, 'held');
    const expired = await queue();
    const [claim] = await worker.$queryRaw<{ token: string }[]>`SELECT token FROM control.claim_ticket_reply()`;
    const [wrong] = await worker.$queryRaw<{ state: string | null }[]>`SELECT control.finish_ticket_reply(${expired}::uuid,${randomUUID()}::uuid,'sent') AS state`;
    assert.equal(wrong.state, null);
    assert.equal((await state(expired)).state, 'sending');
    await db.$executeRaw`UPDATE control.ticket_reply_outbox SET lease_until=now() WHERE message_row_id=${expired}::uuid`;
    const never = { send: () => { throw new Error('unexpected send'); } };
    assert.equal(await dispatchOutbox(worker,never,signal), 'idle');
    assert.equal((await state(expired)).state, 'held');
    const [stale] = await worker.$queryRaw<{ state: string | null }[]>`SELECT control.finish_ticket_reply(${expired}::uuid,${claim.token}::uuid,'sent') AS state`;
    assert.equal(stale.state, null);
  });
  await t.test('atomically limits competing attempts at the UTC daily ceiling', async () => {
    await db.$executeRaw`UPDATE control.outbox_daily_quota SET attempts=99 WHERE day=(now() AT TIME ZONE 'UTC')::date`;
    const ids = await Promise.all([queue(),queue()]);
    let calls = 0;
    const send = () => { calls++; return Promise.resolve({ status: 'rejected', responseCode: 550, retryable: false } as const); };
    const statuses = await Promise.all(ids.map(() => dispatchOutbox(worker,{ send },signal)));
    assert.deepEqual(statuses.sort(), ['failed','idle']);
    assert.equal(await quota(), 100); assert.equal(calls, 1);
    assert.deepEqual((await Promise.all(ids.map(state))).map(s => s.state).sort(), ['failed','queued']);
    assert.equal(await dispatchOutbox(worker,{ send },signal), 'idle');
    assert.equal(calls, 1);
  });
}
