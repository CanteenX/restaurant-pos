import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createGmailImap, type GmailImapFactory } from './gmail-imap.ts';

const env = {
  CONTROL_GMAIL_USER: 'support@example.test',
  CONTROL_GMAIL_APP_PASSWORD: 'x'.repeat(16),
};
const cursor = { uidValidity: '7', afterUid: 10 };
const providerId = '12345678901234567890';
const row = { seq: 1, uid: 11, size: 300, emailId: providerId };
const meta = { expectedSize: row.size, contentType: 'text/plain' };
const plain = { type: 'text/plain', part: '1' };
const structure = {
  type: 'multipart/mixed',
  childNodes: [
    plain,
    { type: 'text/plain', part: '2', parameters: { name: 'notes.txt' } },
    { type: 'text/html', part: '3' },
  ],
};

function harness(overrides: Partial<ReturnType<GmailImapFactory>> = {}) {
  const calls: string[] = [];
  let captured: Parameters<GmailImapFactory>[0] | undefined;
  const client: ReturnType<GmailImapFactory> = {
    on: () => undefined,
    connect: () => { calls.push('connect'); return Promise.resolve(); },
    mailboxOpen: (path, options) => {
      assert.equal(path, 'INBOX');
      assert.equal(options.readOnly, true);
      calls.push('open');
      return Promise.resolve({ uidValidity: 7n, uidNext: 100 });
    },
    fetchAll: (range, query, options) => {
      calls.push('sizes ' + range);
      assert.deepEqual(query, { uid: true, size: true, emailId: true });
      assert.equal(options.uid, true);
      return Promise.resolve([row]);
    },
    fetchOne: (uid, query, options) => {
      calls.push('metadata ' + uid);
      assert.deepEqual(query, {
        uid: true, size: true, emailId: true, bodyStructure: true, envelope: true, labels: true,
        headers: ['references', 'auto-submitted', 'list-id'],
      });
      assert.equal(options.uid, true);
      return Promise.resolve({ ...row, bodyStructure: structure });
    },
    download: (uid, part, options) => {
      calls.push('body ' + uid + ':' + part);
      assert.equal(options.uid, true);
      assert.equal(options.maxBytes, 65_537);
      assert.deepEqual(Object.entries(options).find(([key]) => key === 'decodeText'), ['decodeText', false]);
      return Promise.resolve({ meta, content: Readable.from([Buffer.from('Plain only')]) });
    },
    close: () => { calls.push('close'); },
    ...overrides,
  };
  const adapter = createGmailImap(env, (options) => {
    captured = options;
    return client;
  });
  return { adapter, calls, options: () => captured };
}

void test('preflights size and selects only inline plain text on verified Gmail IMAP', async () => {
  const { adapter, calls, options } = harness();
  const result = await adapter.poll(cursor, new AbortController().signal);
  assert.equal(adapter.mailbox, env.CONTROL_GMAIL_USER);
  const tls = options();
  assert.equal(tls?.host, 'imap.gmail.com');
  assert.equal(tls?.port, 993);
  assert.equal(tls?.secure, true);
  assert.deepEqual(tls?.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'imap.gmail.com' });
  assert.equal(tls?.logger, false);
  assert.equal(tls?.logRaw, false);
  assert.equal(tls?.emitLogs, false);
  assert.equal(tls?.disableAutoIdle, true);
  assert.deepEqual(calls, ['connect', 'open', 'sizes 11:18', 'metadata 11', 'body 11:1', 'close']);
  assert.equal(result.status, 'batch');
  assert.equal(result.throughUid, 18);
  assert.deepEqual(result.messages[0], {
    uid: 11,
    providerId,
    result: { disposition: 'accept', reason: 'attachments-omitted', omittedAttachments: 1 },
    text: 'Plain only',
    envelope: undefined,
    headers: undefined,
  });
});

void test('requires a valid cursor and stops old UID windows at an epoch change', async () => {
  const { adapter, calls } = harness();
  const signal = new AbortController().signal;
  await assert.rejects(adapter.poll({ ...cursor, afterUid: -1 }, signal), /Invalid Gmail inbox cursor/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await adapter.poll({ ...cursor, uidValidity: '6' }, signal), {
    status: 'resync', uidValidity: '7',
  });
  assert.deepEqual(calls, ['connect', 'open', 'close']);
  const stale = harness({ mailboxOpen: () => Promise.resolve({ uidValidity: 7n, uidNext: 10 }) });
  await assert.rejects(stale.adapter.poll(cursor, signal), { message: 'Gmail inbox retrieval failed' });
});

void test('stops oversized wire messages before fetching metadata', async () => {
  const { adapter, calls } = harness({ fetchAll: () => Promise.resolve([{ ...row, size: 2_097_153 }]) });
  const result = await adapter.poll(cursor, new AbortController().signal);
  assert.equal(result.status, 'batch');
  assert.deepEqual(result.messages[0]?.result, {
    disposition: 'quarantine', reason: 'budget-exceeded', measurement: 'wireBytes',
  });
  assert.deepEqual(calls, ['connect', 'open', 'close']);
});

void test('holds disappeared and ambiguous plain parts without downloading them', async () => {
  for (const [bodyStructure, reason] of [[undefined, 'missing-metadata'], [
    { type: 'multipart/mixed', childNodes: [plain, { ...plain, part: '2' }] },
    'ambiguous-plaintext',
  ], [{ type: 'text/html', childNodes: [] }, 'missing-plaintext']] as const) {
    const { adapter, calls } = harness({
      fetchOne: () => Promise.resolve(bodyStructure ? { ...row,
        bodyStructure: { ...bodyStructure, childNodes: [...bodyStructure.childNodes] },
      } : false),
    });
    const result = await adapter.poll(cursor, new AbortController().signal);
    assert.equal(result.status, 'batch');
    assert.deepEqual(result.messages[0]?.result, { disposition: 'quarantine', reason });
    assert.ok(!calls.some((call) => call.startsWith('body')));
  }
});

void test('checks actual decoded UTF-8 bytes and returns no partial text', async () => {
  const { adapter } = harness({
    download: () => Promise.resolve({ meta, content: Readable.from([
      Buffer.alloc(65_536), Buffer.from('x'),
    ]) }),
  });
  const result = await adapter.poll(cursor, new AbortController().signal);
  assert.equal(result.status, 'batch');
  assert.deepEqual(result.messages[0]?.result, {
    disposition: 'quarantine', reason: 'budget-exceeded', measurement: 'decodedTextBytes',
  });
  assert.equal(result.messages[0]?.text, undefined);
});

void test('redacts disconnects and closes even a hung connection on abort', async () => {
  const failed = harness({ connect: () => Promise.reject(new Error('synthetic detail')) });
  await assert.rejects(failed.adapter.poll(cursor, new AbortController().signal), {
    message: 'Gmail inbox retrieval failed',
  });
  assert.deepEqual(failed.calls, ['close']);

  const controller = new AbortController();
  const hung = harness({ connect: () => new Promise(() => { setImmediate(() => controller.abort()); }) });
  await assert.rejects(hung.adapter.poll(cursor, controller.signal), { message: 'Gmail inbox retrieval failed' });
  assert.deepEqual(hung.calls, ['close']);
});

void test('checks the selected part metadata and decoded charset expansion', async () => {
  for (const [partMeta, data, reason] of [
    [{ ...meta, filename: 'file.txt' }, Buffer.from('Attachment'), 'missing-metadata'],
    [{ ...meta, charset: 'iso-8859-1' }, Buffer.alloc(33_000, 0xe9), 'budget-exceeded'],
    [{ ...meta, charset: 'utf-8' }, Buffer.from([0xff]), 'invalid-text'],
  ] as const) {
    const content = Readable.from([data]);
    const { adapter } = harness({ download: () => Promise.resolve({ meta: partMeta, content }) });
    const result = await adapter.poll(cursor, new AbortController().signal);
    assert.equal(result.status, 'batch');
    assert.equal(result.messages[0]?.result.reason, reason);
    assert.equal(result.messages[0]?.text, undefined);
    assert.equal(content.destroyed, true);
  }
});

void test('uses opaque provider IDs and rejects oversize MIME trees before download', async () => {
  const fake = { ...row, emailId: 'Opaque_Provider-Id' };
  const { adapter, calls } = harness({
    fetchAll: () => Promise.resolve([fake]),
    fetchOne: () => Promise.resolve({ ...fake,
      bodyStructure: { type: 'multipart/mixed', childNodes: Array.from({ length: 32 }, () => plain) },
    }),
  });
  const result = await adapter.poll(cursor, new AbortController().signal);
  assert.equal(result.status, 'batch');
  assert.equal(result.messages[0]?.providerId, fake.emailId);
  assert.deepEqual(result.messages[0]?.result, {
    disposition: 'quarantine', reason: 'budget-exceeded', measurement: 'mimeParts',
  });
  assert.deepEqual(calls, ['connect', 'open', 'close']);
});

void test('rejects conflicting identities and skips provider spam before receiving a body', async () => {
  const signal = new AbortController().signal;
  const stale = harness({ fetchOne: () => Promise.resolve({ ...row, emailId: 'different', bodyStructure: structure }) });
  await assert.rejects(stale.adapter.poll(cursor, signal), { message: 'Gmail inbox retrieval failed' });
  assert.deepEqual(stale.calls, ['connect', 'open', 'sizes 11:18', 'close']);

  const spam = harness({ fetchOne: () => Promise.resolve({ ...row, labels: new Set(['\\Spam']), bodyStructure: structure }) });
  const result = await spam.adapter.poll(cursor, signal);
  assert.equal(result.status, 'batch');
  assert.deepEqual(result.messages[0]?.result, { disposition: 'skip', reason: 'provider-spam' });
  assert.deepEqual(spam.calls, ['connect', 'open', 'sizes 11:18', 'close']);
});

void test('destroys a pending body stream as well as the client on abort', async () => {
  const cancel = new AbortController();
  const stalled = new Readable({ read() { setImmediate(() => cancel.abort()); } });
  const { adapter, calls } = harness({ download: () => Promise.resolve({ meta, content: stalled }) });
  await assert.rejects(adapter.poll(cursor, cancel.signal), { message: 'Gmail inbox retrieval failed' });
  assert.equal(stalled.destroyed, true);
  assert.equal(calls.at(-1), 'close');
});

void test('suppresses Gmail sent copies, auto replies and list mail before downloading text', async () => {
  for (const [metadata, reason] of [
    [{ labels: new Set(['\\Sent']) }, 'self-mail'],
    [{ headers: Buffer.from('Auto-Submitted: auto-replied\r\n') }, 'auto-submitted'],
    [{ headers: Buffer.from('List-Id: synthetic <list.test>\r\n') }, 'mailing-list'],
    [{ headers: Buffer.alloc(8193) }, 'invalid-headers'],
  ] as const) {
    const { adapter, calls } = harness({ fetchOne: () => Promise.resolve({ ...row, bodyStructure: structure, ...metadata }) });
    const result = await adapter.poll(cursor, new AbortController().signal);
    assert.equal(result.status, 'batch');
    assert.equal(result.messages[0].result.reason, reason);
    assert.ok(!calls.some((call) => call.startsWith('body')));
  }
});

void test('quarantines duplicate References even when the first header is empty', async () => {
  const headers = Buffer.from('References:\r\nrEfErEnCeS: <parent@example.test>\r\n');
  const { adapter, calls } = harness({ fetchOne: () => Promise.resolve({ ...row, bodyStructure: structure, headers }) });
  const result = await adapter.poll(cursor, new AbortController().signal);
  assert.equal(result.status, 'batch');
  assert.deepEqual(result.messages[0].result, { disposition: 'quarantine', reason: 'invalid-headers' });
  assert.ok(!calls.some((call) => call.startsWith('body')));
});
