import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

import { pollInbox } from './inbox-intake.js';

export async function intakeCases(t: TestContext, db: PrismaClient, worker: PrismaClient) {
  const mailbox = 'inbox-flow@example.test', sender = 'member@example.test', signal = new AbortController().signal;
  const message = (uid: number, providerId: string, messageId: string, parent?: string) => ({
    uid, providerId, text: 'Plain fixture', result: { disposition: 'accept', reason: 'attachments-omitted', omittedAttachments: 1 },
    envelope: { subject: 'Re: similar subject', from: [{ address: sender }], messageId, inReplyTo: parent },
    headers: Buffer.from('Authentication-Results: fake; dkim=pass\r\n'),
  });
  const verified = ({ mailbox: source, providerId }: { mailbox: string; providerId: string }) =>
    source === mailbox && ['root','reply','second','ambiguous'].includes(providerId) ? sender : null;
  const run = (epoch: string, throughUid: number, messages: unknown[], address = mailbox) => pollInbox(worker, {
    mailbox: address, poll: () => Promise.resolve({ status: 'batch', uidValidity: epoch, throughUid, messages }),
  }, signal, verified);
  const cursor = (address = mailbox) => db.mailboxCursor.findUniqueOrThrow({ where: { mailbox: address } });
  const receipt = (providerId: string) => db.inboundReceipt.findUniqueOrThrow({
    where: { mailbox_providerId: { mailbox, providerId } }, include: { message: true },
  });
  await t.test('threads only authenticated participants and explicit unambiguous references', async () => {
    const root = message(1,'root','<root@example.test>'), parent = root.envelope.messageId;
    const reply = message(2,'reply','<reply@example.test>');
    reply.headers = Buffer.from('References:\r\n ' + parent + '\r\nAuto-Submitted: no\r\n');
    const second = message(4,'second','<second@example.test>');
    const ambiguous = message(5,'ambiguous','<third@example.test>', parent);
    ambiguous.headers = Buffer.from('References: ' + second.envelope.messageId + '\r\n');
    await run('11',1,[root]);
    const first = await receipt('root'), businessId = randomUUID();
    await db.business.create({ data: { id: businessId, legalName: 'Fixture', displayName: 'Fixture' } });
    await db.ticket.update({ where: { id: first.message!.ticketId }, data: { businessId } });
    const spoof = { ...message(3,'spoof','<spoof@example.test>',parent), verifiedSender: sender };
    await run('11',5,[reply,spoof,second,ambiguous]);
    const [a,b,c,d,e] = await Promise.all(['root','reply','spoof','second','ambiguous'].map(receipt));
    assert.equal(a.message!.ticketId, b.message!.ticketId);
    assert.equal(a.verifiedSender, sender);
    assert.equal(b.omittedAttachments, 1);
    assert.equal(b.message!.sequence, 2);
    assert.equal(c.verifiedSender, null);
    assert.equal(new Set([a,c,d,e].map((r) => r.message!.ticketId)).size, 4);
    const triage = await db.ticket.findUniqueOrThrow({ where: { id: c.message!.ticketId } });
    assert.deepEqual([triage.businessId,triage.outletId,triage.ownerId], [null,null,null]);
    assert.equal(await db.auditEvent.count({ where: { action: 'ticket.inbound', subjectId: a.message!.ticketId } }), 2);
  });
  await t.test('leaves the audit lock available while waiting on a later ticket in the batch', async () => {
    const address = 'lock-order@example.test';
    const batch = (throughUid: number, messages: unknown[]) => pollInbox(worker, { mailbox: address,
      poll: () => Promise.resolve({ status: 'batch', uidValidity: '55', throughUid, messages }),
    }, signal, () => sender);
    const first = '<first@example.test>', second = '<second@example.test>';
    await batch(2, [message(1,'first',first),message(2,'second',second)]);
    const target = await db.inboundReceipt.findUniqueOrThrow({
      where: { mailbox_providerId: { mailbox: address, providerId: 'second' } }, include: { message: true },
    });
    let pending!: Promise<string>;
    const observed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM control.ticket WHERE id = ${target.message!.ticketId}::uuid FOR UPDATE`;
      pending = batch(4,[message(3,'reply-a','<reply-a@example.test>',first),message(4,'reply-b','<reply-b@example.test>',second)]);
      const deadline = Date.now() + 3000;
      let blocked = false;
      do {
        const [activity] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = activity.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      } while (!blocked && Date.now() < deadline);
      const [probe] = await tx.$queryRaw<{ available: boolean }[]>`SELECT pg_try_advisory_xact_lock(1314276174, 1) AS available`;
      return { blocked, available: probe.available };
    });
    await pending;
    assert.deepEqual(observed, { blocked: true, available: true });
    assert.equal((await cursor(address)).throughUid, 4n);
    assert.equal(await db.auditEvent.count({ where: { action: 'ticket.inbound', subjectId: target.message!.ticketId } }), 2);
  });
  await t.test('stores skip/quarantine, deduplicates across UID epochs and preserves a bounded cursor', async () => {
    await run('11',8,[
      { uid: 6, providerId: 'skip', result: { disposition: 'skip', reason: 'provider-spam' } },
      { uid: 7, providerId: 'held', result: { disposition: 'quarantine', reason: 'invalid-text' } },
      { ...message(8,'blank','<blank@example.test>'), text: '' },
    ]);
    assert.equal((await receipt('skip')).messageRowId, null);
    assert.equal((await receipt('held')).outcome, 'quarantine');
    assert.ok((await receipt('blank')).message!.text.trim());
    const before = await receipt('root');
    await pollInbox(worker, { mailbox, poll: () => Promise.resolve({ status: 'resync', uidValidity: '12' }) }, signal);
    assert.equal((await cursor()).throughUid, 0n);
    await run('12',1,[message(1,'root','<changed@example.test>')]);
    assert.deepEqual(await receipt('root'), before);
    assert.equal(await db.mailboxDelivery.count({ where: { mailbox, providerId: 'root' } }), 2);
    await assert.rejects(run('12',2,[message(4,'wrong','<wrong@example.test>')]));
    await assert.rejects(run('13',2,[]));
    assert.equal((await cursor()).throughUid, 1n);
    assert.equal((await cursor()).leaseToken, null);
    await pollInbox(worker, { mailbox, poll: () => Promise.resolve({ status: 'resync', uidValidity: '11' }) }, signal);
    await assert.rejects(run('11',1,[message(1,'conflict','<different@example.test>')]));
    assert.equal((await cursor()).throughUid, 0n);
    await run('12',1,[message(1,'root','<root@example.test>')],'separate-flow@example.test');
    assert.equal(await db.inboundReceipt.count({ where: { providerId: 'root' } }), 2);
  });
  await t.test('retains exactly one claimed From independently of verification and ignores Reply-To', async () => {
    const address = 'claimed-flow@example.test';
    const single = message(1,'single','<single@example.test>');
    single.envelope.from = [{ address: 'Buyer@EXAMPLE.TEST' }];
    single.headers = Buffer.from('Reply-To: alternate@example.test\r\nAuthentication-Results: bogus; dkim=pass\r\n');
    const many = message(2,'many','<many@example.test>');
    many.envelope.from = [{ address: sender }, { address: 'other@example.test' }];
    const invalid = message(3,'invalid','<invalid@example.test>');
    invalid.envelope.from = [{ address: 'not-an-address' }];
    const mismatched = message(4,'mismatched','<mismatch@example.test>','<root@example.test>');
    await pollInbox(worker, { mailbox: address, poll: () => Promise.resolve({
      status: 'batch', uidValidity: '8', throughUid: 4, messages: [single,many,invalid,mismatched],
    }) }, signal, () => 'unrelated@example.test');
    const stored = await db.$queryRaw<{ provider_id: string; claimed_sender: string | null; verified_sender: string | null }[]>`
      SELECT provider_id,claimed_sender,verified_sender FROM control.inbound_receipt WHERE mailbox = ${address} ORDER BY provider_id`;
    assert.deepEqual(stored.map((r) => [r.provider_id,r.claimed_sender,r.verified_sender]),
      [['invalid',null,null],['many',null,null],['mismatched',sender,null],['single','Buyer@example.test',null]]);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$queryRaw`SELECT claimed_sender,provider_id FROM control.inbound_receipt`;
    }), (e: unknown) => (e as { meta?: { code?: string } }).meta?.code === '42501');
  });
  await t.test('quarantines unsafe text and rejects malformed windows before advancing', async () => {
    const address = 'invalid-flow@example.test';
    const first = { ...message(1,'oversized','<large@example.test>'), text: 'é'.repeat(33_000) };
    const second = { ...message(2,'nul','<nul@example.test>'), text: 'a\0b' };
    await run('6',2,[first,second],address);
    const rows = await db.inboundReceipt.findMany({ where: { mailbox: address }, orderBy: { providerId: 'asc' } });
    assert.deepEqual(rows.map((row) => [row.outcome,row.reason,row.messageRowId]),
      [['quarantine','invalid-text',null],['quarantine','budget-exceeded',null]]);
    await assert.rejects(pollInbox(worker, { mailbox: address, poll: () => Promise.resolve({
      status: 'batch', mailbox: 'other@example.test', uidValidity: '6', throughUid: 3, messages: [],
    }) }, signal), { message: 'Inbox intake failed' });
    const unexpected = { ...message(3,'inconsistent','<odd@example.test>'),
      result: { disposition: 'accept', reason: 'accepted', omittedAttachments: 4 } };
    await assert.rejects(run('6',3,[unexpected],address), { message: 'Inbox intake failed' });
    assert.equal((await cursor(address)).throughUid, 2n);
  });
  await t.test('releases failed polls, fences stale results and rolls back an entire batch on storage failure', async () => {
    const address = 'retry-intake@example.test', failure = { message: 'Inbox intake failed' };
    await assert.rejects(pollInbox(worker, { mailbox: address, poll: () => Promise.reject(new Error('private-marker')) }, signal), failure);
    assert.equal((await cursor(address)).leaseToken, null);
    let ready!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const stale = pollInbox(worker, { mailbox: address, poll: async () => {
      ready(); await waiting; return { status: 'batch', uidValidity: '9', throughUid: 1, messages: [] };
    } }, signal);
    await started;
    assert.equal(await run('9',1,[],address), 'busy');
    await db.$executeRaw`UPDATE control.mailbox_cursor SET lease_until = clock_timestamp() WHERE mailbox = ${address}`;
    assert.equal(await run('9',1,[],address), 'batch');
    finish(); await assert.rejects(stale, failure);
    const batch = [message(2,'retry-first','<retry@example.test>'),message(3,'retry-second','<retry2@example.test>')];
    const count = await db.ticket.count();
    await db.$executeRaw`ALTER TABLE control.inbound_receipt ADD CONSTRAINT test_intake_rollback CHECK (provider_id <> 'retry-second') NOT VALID`;
    try {
      await assert.rejects(run('9',3,batch,address), failure);
      assert.equal((await cursor(address)).throughUid, 1n);
      assert.equal(await db.ticket.count(), count);
      assert.equal(await db.mailboxDelivery.count({ where: { mailbox: address } }), 0);
    } finally { await db.$executeRaw`ALTER TABLE control.inbound_receipt DROP CONSTRAINT test_intake_rollback`; }
    await run('9',3,batch,address);
    assert.equal(await db.mailboxDelivery.count({ where: { mailbox: address } }), 2);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_inbound_audit CHECK (action <> 'ticket.inbound') NOT VALID`;
    try {
      await assert.rejects(run('9',4,[message(4,'audit-rollback','<audit@example.test>')],address), failure);
      assert.equal((await cursor(address)).throughUid, 3n);
      assert.equal(await db.inboundReceipt.count({ where: { providerId: 'audit-rollback' } }), 0);
      assert.equal(await db.ticket.count(), count + 2);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_inbound_audit`; }
  });
}
