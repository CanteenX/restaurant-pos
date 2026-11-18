import assert from 'node:assert/strict';
import test from 'node:test';
import { readGmailConfig } from './gmail-config.ts';
import { createGmailSmtp, type GmailSmtpFactory } from './gmail-smtp.ts';

const env = {
  CONTROL_GMAIL_USER: 'support@example.test',
  CONTROL_GMAIL_APP_PASSWORD: 'x'.repeat(16),
};
const reply = {
  to: 'customer@example.test',
  subject: 'Re: Printer',
  messageId: '<reply-547@support.example.test>',
  inReplyTo: '<request-103@customer.example.test>',
  text: 'Restart the printer.',
  html: '<p>Restart the printer.</p>',
};
const accepted = {
  accepted: [reply.to],
  rejected: [],
  messageId: reply.messageId,
  response: '250 2.0.0 OK',
};

void test('validates complete Gmail configuration with a fixed diagnostic', () => {
  assert.equal(readGmailConfig(env).user, env.CONTROL_GMAIL_USER);
  for (const invalid of [
    {},
    { CONTROL_GMAIL_USER: env.CONTROL_GMAIL_USER },
    { CONTROL_GMAIL_APP_PASSWORD: env.CONTROL_GMAIL_APP_PASSWORD },
    { ...env, CONTROL_GMAIL_USER: 'smtp://example.test' },
    { ...env, CONTROL_GMAIL_APP_PASSWORD: 'fixture-invalid-value' },
  ]) {
    assert.throws(() => readGmailConfig(invalid), {
      message: 'Invalid Gmail transport configuration',
    });
  }
});

void test('pins verified SMTP TLS, silence and single-recipient options', async () => {
  const factory: GmailSmtpFactory = (options) => {
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.deepEqual(options.tls, {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      servername: 'smtp.gmail.com',
    });
    assert.equal(options.logger, false);
    assert.equal(options.debug, false);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
    assert.equal(options.auth?.user, env.CONTROL_GMAIL_USER);
    return {
      sendMail: (message) => {
        assert.deepEqual(message.envelope, { from: env.CONTROL_GMAIL_USER, to: [reply.to] });
        assert.deepEqual(message.to, { name: '', address: reply.to });
        assert.equal(message.messageId, reply.messageId);
        assert.equal(message.inReplyTo, reply.inReplyTo);
        assert.equal(message.references, reply.inReplyTo);
        assert.equal(message.html, reply.html);
        assert.equal(message.text, reply.text);
        return Promise.resolve(accepted);
      },
    };
  };

  const sender = createGmailSmtp({ ...env, CONTROL_GMAIL_SMTP_HOST: 'example.test' }, factory);
  assert.deepEqual(await sender.send(reply), { status: 'sent', messageId: reply.messageId });
});

void test('can construct the default sender without opening a connection', () => {
  assert.equal(typeof createGmailSmtp(env).send, 'function');
});

void test('rejects recipient, message ID, header and file-input injection locally', async () => {
  const sender = createGmailSmtp(env, () => ({
    sendMail: () => assert.fail('Invalid reply must be rejected before SMTP'),
  }));
  for (const invalid of [
    { ...reply, to: 'one@example.test,two@example.test' },
    { ...reply, subject: 'Printer\r\nBcc: fixture@example.test' },
    { ...reply, messageId: '<one@example.test><two@example.test>' },
    { ...reply, inReplyTo: '<parent@example.test>\n' },
    { ...reply, text: { path: 'fixture-file' } },
    { ...reply, cc: 'extra@example.test' },
  ]) assert.deepEqual(await sender.send(invalid), { status: 'invalid' });
});

void test('classifies explicit SMTP rejection without exposing response text', async () => {
  for (const [command, code, responseCode, retryable] of [
    ['RCPT TO', 'EENVELOPE', 450, true],
    ['AUTH PLAIN', 'EAUTH', 535, false],
    ['DATA', 'EENVELOPE', 451, true],
    ['DATA', 'EMESSAGE', 550, false],
  ] as const) {
    const error = Object.assign(new Error('synthetic sensitive detail'), {
      command, code, responseCode, response: responseCode + ' synthetic sensitive detail',
    });
    const sender = createGmailSmtp(env, () => ({ sendMail: () => Promise.reject(error) }));
    assert.deepEqual(await sender.send(reply), { status: 'rejected', responseCode, retryable });
  }
});

void test('holds disconnected or incomplete SMTP results for reconciliation', async () => {
  for (const fields of [
    { command: 'DATA', code: 'ECONNECTION' },
    { command: 'DATA', code: 'EAUTH', responseCode: 450, response: '450 missing phase' },
    { command: 'DATA', code: 'EMESSAGE', responseCode: 450, response: '451 inconsistent code' },
  ]) {
    const error = Object.assign(new Error('synthetic sensitive detail'), fields);
    const sender = createGmailSmtp(env, () => ({ sendMail: () => Promise.reject(error) }));
    assert.deepEqual(await sender.send(reply), { status: 'ambiguous' });
  }

  for (const info of [
    { ...accepted, accepted: ['different@example.test'] },
    { ...accepted, rejected: [reply.to] },
    { ...accepted, messageId: '<different@example.test>' },
    { ...accepted, response: '421 disconnected' },
    undefined,
  ]) {
    const sender = createGmailSmtp(env, () => ({ sendMail: () => Promise.resolve(info) }));
    assert.deepEqual(await sender.send(reply), { status: 'ambiguous' });
  }
});

void test('redacts transport construction errors', () => {
  assert.throws(() => createGmailSmtp(env, () => { throw new Error('synthetic sensitive detail'); }), {
    message: 'Unable to initialize Gmail SMTP transport',
  });
});
