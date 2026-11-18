import { intakeCases } from './inbox-intake.integration.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Prisma, PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

import { acquireMailbox, commitMailbox, releaseMailbox, type MailboxAdvance } from './mailbox-lease.js';

export async function inboxStorageCases(t: TestContext, db: PrismaClient, url: string, ticketsUrl: string) {
  const mailbox = 'intake@example.test', other = 'other@example.test';
  const denied = (code: string) => (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.meta?.code === code;
  await t.test('installs distinct receipt and UID delivery identities', async () => {
    const rows = await db.$queryRaw<{ available: boolean }[]>`SELECT
      to_regclass('control.inbound_receipt') IS NOT NULL AND to_regclass('control.mailbox_delivery') IS NOT NULL AS available`;
    assert.equal(rows[0].available, true);
  });
  await db.$executeRaw`CREATE ROLE control_mail_worker NOLOGIN`;
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'execute', '--file',
    'operator/mail-worker-grants.sql', '--schema', 'prisma/schema.prisma'], { env: { ...process.env, CONTROL_DATABASE_URL: url }, stdio: 'ignore' });
  const workerUrl = new URL(url);
  workerUrl.searchParams.set('options', '-c role=control_mail_worker');
  const worker = new PrismaClient({ datasourceUrl: workerUrl.toString() });
  t.after(() => worker.$disconnect());
  const runtime = (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
    return work(tx);
  });
  const ticket = randomUUID(), message = randomUUID();
  await t.test('restricts worker access and pages inbound text in the staff timeline', async () => {
    await worker.$executeRaw`INSERT INTO control.ticket(id,subject) VALUES (${ticket}::uuid,'Fixture')`;
    await worker.$executeRaw`INSERT INTO control.ticket_message(id,ticket_id,sequence,direction,visibility,text)
      VALUES (${message}::uuid,${ticket}::uuid,1,'inbound','public',repeat('a',4100))`;
    await assert.rejects(worker.$executeRaw`INSERT INTO control.ticket_message(id,ticket_id,sequence,direction,visibility,text)
      VALUES (${randomUUID()}::uuid,${ticket}::uuid,2,'inbound','staff','wrong visibility')`, denied('23514'));
    await assert.rejects(worker.$queryRaw`SELECT text FROM control.ticket_message`, denied('42501'));
    await assert.rejects(worker.$executeRaw`UPDATE control.ticket SET business_id = NULL`, denied('42501'));
    await assert.rejects(worker.$executeRaw`INSERT INTO control.ticket_message(id,ticket_id,sequence,direction,text)
      VALUES (${randomUUID()}::uuid,${ticket}::uuid,2,'internal','forged')`, denied('23514'));
    await assert.rejects(runtime((tx) => tx.$queryRaw`SELECT * FROM control.inbound_receipt`), denied('42501'));
    const token = 'A'.repeat(43), id = randomUUID();
    await db.staff.create({ data: { id, email: 'inbox-reader@example.test', passwordHash: 'inert', grants: ['cc.ticket.read'] } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(), expiresAt: new Date(Date.now()+60_000) } });
    const response = await fetch(ticketsUrl + '/' + ticket, { headers: { cookie: '__Host-control_staff=' + token } });
    const detail = await response.json() as { messages: { items: { id: string; direction: string; visibility: string; authorId: string | null }[] } };
    assert.equal(response.status, 200);
    assert.deepEqual(detail.messages.items.map((m) => [m.id, m.direction, m.visibility, m.authorId]), [[message, 'inbound', 'public', null]]);
  });
  await t.test('accepts inbound message references and rejects a staff note as a receipt target', async () => {
    const address = 'receipt-kind@example.test', noteId = randomUUID();
    const actor = await db.staff.findUniqueOrThrow({ where: { email: 'inbox-reader@example.test' }, select: { id: true } });
    await runtime((tx) => tx.ticketMessage.create({ data: { id: noteId, ticketId: ticket, sequence: 2,
      requestKey: randomUUID(), authorId: actor.id, text: 'Synthetic internal note' }, select: { id: true } }));
    const lease = await acquireMailbox(worker, address);
    assert.ok(lease);
    await releaseMailbox(worker, lease);
    const accept = (providerId: string, messageRowId: string) => worker.inboundReceipt.create({
      data: { mailbox: address, providerId, outcome: 'accept', reason: 'accepted', messageRowId }, select: { providerId: true },
    });
    assert.deepEqual(await accept('public-message', message), { providerId: 'public-message' });
    await assert.rejects(accept('staff-note', noteId), (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003');
    await assert.rejects(worker.$executeRaw`INSERT INTO control.inbound_receipt
      (mailbox,provider_id,outcome,reason,message_row_id,message_direction)
      VALUES (${address},'wrong-kind','accept','accepted',${noteId}::uuid,'internal')`, denied('23514'));
    await assert.rejects(accept('second-receipt', message), (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002');
    assert.equal(await worker.inboundReceipt.count({ where: { mailbox: address } }), 1);
  });
  await t.test('fences concurrent leases, rollback, expiry, cross-mailbox and cursor rewinds', async () => {
    const pair = await Promise.all([acquireMailbox(worker, mailbox), acquireMailbox(worker, mailbox)]);
    assert.equal(pair.filter(Boolean).length, 1);
    const first = pair.find(Boolean);
    assert.ok(first);
    const advance: MailboxAdvance = { status: 'batch', uidValidity: '19', throughUid: 4 };
    const second = await acquireMailbox(worker, other);
    assert.ok(second);
    await assert.rejects(commitMailbox(worker, { ...first, mailbox: other }, advance, () => Promise.resolve()));
    await releaseMailbox(worker, second);
    const receipt = (tx: Prisma.TransactionClient) => tx.$executeRaw`INSERT INTO control.inbound_receipt(mailbox,provider_id,outcome,reason)
      VALUES (${mailbox},'one','skip','provider-spam')`;
    await assert.rejects(commitMailbox(worker, first, advance, async (tx: Prisma.TransactionClient) => {
      await receipt(tx); throw new Error('discard');
    }), /discard/);
    await db.$executeRaw`UPDATE control.mailbox_cursor SET lease_until = clock_timestamp() WHERE mailbox = ${mailbox}`;
    const current = await acquireMailbox(worker, mailbox);
    assert.ok(current);
    assert.equal(current.afterUid, 0);
    await releaseMailbox(worker, first);
    await assert.rejects(commitMailbox(worker, first, advance, receipt));
    await assert.rejects(commitMailbox(worker, current, advance, async (tx) => {
      await receipt(tx);
      await tx.$executeRaw`UPDATE control.mailbox_cursor SET lease_until = clock_timestamp() WHERE mailbox = ${mailbox}`;
    }), /expired/);
    await commitMailbox(worker, current, advance, async (tx: Prisma.TransactionClient) => {
      await receipt(tx);
      await tx.$executeRaw`INSERT INTO control.mailbox_delivery(mailbox,uid_validity,uid,provider_id)
        VALUES (${mailbox},19,4,'one')`;
    });
    await assert.rejects(worker.$executeRaw`INSERT INTO control.inbound_receipt(mailbox,provider_id,outcome,reason)
        VALUES (${mailbox},'one','skip','provider-spam')`, denied('23505'));
    await assert.rejects(worker.$executeRaw`INSERT INTO control.mailbox_delivery(mailbox,uid_validity,uid,provider_id)
        VALUES (${mailbox},19,4,'one')`, denied('23505'));
    await assert.rejects(worker.$executeRaw`INSERT INTO control.mailbox_delivery(mailbox,uid_validity,uid,provider_id)
        VALUES (${other},19,5,'one')`, denied('23503'));
    const next = await acquireMailbox(worker, mailbox);
    assert.ok(next);
    assert.equal(next.afterUid, 4); assert.equal(next.uidValidity, '19');
    for (const invalid of [{ ...advance, throughUid: 3 }, { ...advance, throughUid: 13 }, { ...advance, uidValidity: '20' }]) {
      await assert.rejects(commitMailbox(worker, next, invalid, () => Promise.resolve()));
    }
    await commitMailbox(worker, next, { status: 'resync', uidValidity: '20', throughUid: 0 }, () => Promise.resolve());
    const reset = await acquireMailbox(worker, mailbox);
    assert.ok(reset);
    assert.equal(reset.afterUid, 0); assert.equal(reset.uidValidity, '20');
    await releaseMailbox(worker, reset);
  });
  await intakeCases(t, db, worker);
}
