const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const subject = 'Round-trip printer support';
const recipient = 'Printer.Owner@example.test';
const incomingId = '<printer-origin@example.test>';
const incomingText = 'The receipt printer stopped after the lunch shift.';
const fixtureGmail = {
  CONTROL_GMAIL_USER: 'synthetic-inbox@example.test',
  CONTROL_GMAIL_APP_PASSWORD: 'x'.repeat(16),
};
const roleOption = (role) => '?options=-c%20role%3D' + role;

async function withWorker(run) {
  const port = process.env.CONTROL_QA_DB_PORT;
  const fixture = 'postgresql://fixture:fixture@127.0.0.1:' + port + '/fixture';
  assert.ok(/^[0-9]{5}$/.test(port) && Number(port) >= 32768 && Number(port) <= 65535 &&
    process.env.CONTROL_DATABASE_URL === fixture + roleOption('control_runtime'),
  'This test requires the disposable Control QA fixture');
  const { PrismaClient } = require('../../apps/control-api/node_modules/.prisma/control-client');
  const db = new PrismaClient({ datasourceUrl: fixture + roleOption('control_mail_worker') });
  try {
    const [{ role }] = await db.$queryRaw`SELECT current_user AS role`;
    assert.equal(role, 'control_mail_worker');
    return await run(db, AbortSignal.timeout(10_000));
  } finally {
    await db.$disconnect();
  }
}

function receiveFixtureMail() {
  const { createGmailImap } = require('../../apps/control-api/dist/helpdesk/mail/gmail-imap.js');
  const { pollInbox } = require('../../apps/control-api/dist/helpdesk/mail/inbox-intake.js');
  const row = { seq: 1, uid: 1, size: 250, emailId: 'synthetic-printer-message' };
  const inbox = createGmailImap(fixtureGmail, () => ({
    on() {}, close() {},
    async connect() {},
    async mailboxOpen(path, options) {
      assert.equal(path, 'INBOX');
      assert.equal(options.readOnly, true);
      return { uidValidity: 1n, uidNext: 2 };
    },
    async fetchAll() { return [row]; },
    async fetchOne() {
      return { ...row, bodyStructure: { type: 'text/plain', part: '1' },
        envelope: { subject, messageId: incomingId, from: [{ address: recipient }],
          replyTo: [{ address: 'different-reply-to@example.test' }] } };
    },
    async download() {
      return { meta: { expectedSize: row.size, contentType: 'text/plain' },
        content: Readable.from([Buffer.from(incomingText)]) };
    },
  }));
  return withWorker((db, signal) => pollInbox(db, inbox, signal));
}

function deliverFixtureReply() {
  const { createGmailSmtp } = require('../../apps/control-api/dist/helpdesk/mail/gmail-smtp.js');
  const { dispatchOutbox } = require('../../apps/control-api/dist/helpdesk/mail/outbox-dispatch.js');
  const deliveries = [];
  const smtp = createGmailSmtp(fixtureGmail, () => ({
    async sendMail(message) {
      deliveries.push(message);
      return { accepted: message.envelope.to, rejected: [], messageId: message.messageId, response: '250 Fixture accepted' };
    },
  }));
  return withWorker(async (db, signal) => {
    const state = await dispatchOutbox(db, smtp, signal);
    const next = await dispatchOutbox(db, smtp, signal);
    return { state, next, deliveries };
  });
}

module.exports = { subject, recipient, incomingId, incomingText, receiveFixtureMail, deliverFixtureReply };