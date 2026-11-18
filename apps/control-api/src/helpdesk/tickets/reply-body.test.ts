import assert from 'node:assert/strict';
import test from 'node:test';

import { ticketReply } from '@nventra/types/dist/control-reply';
import { replyTarget } from './reply-target.js';

const requestKey = 'A0A0A0A0-A0A0-4A0A-8A0A-0000000000AB';
const body = { text: 'A reply\r\nwith a second line.', requestKey };

void test('preserves the strict note body bounds and normalizes the reply body and key', () => {
  assert.deepEqual(ticketReply.parse(body), { text: 'A reply\nwith a second line.', requestKey: requestKey.toLowerCase() });
  for (const text of ['', '   ', 'A\u0000B', 'A\uD800B', 'A'.repeat(4001)]) {
    assert.equal(ticketReply.safeParse({ ...body, text }).success, false);
  }
  assert.equal(ticketReply.safeParse({ ...body, requestKey: 'not a UUID' }).success, false);
});

void test('allows explicit true acknowledgment and rejects a client-supplied recipient or mail metadata', () => {
  assert.equal(ticketReply.parse({ ...body, acknowledgeUnverified: true }).acknowledgeUnverified, true);
  for (const acknowledgeUnverified of [false, 'true', 1, null]) {
    assert.equal(ticketReply.safeParse({ ...body, acknowledgeUnverified }).success, false);
  }
  for (const field of ['to', 'recipient', 'from', 'replyTo', 'messageId', 'subject', 'visibility', 'direction']) {
    assert.equal(ticketReply.safeParse({ ...body, [field]: 'untrusted' }).success, false);
  }
});

void test('derives one destination only from a canonical claimed sender with consistent evidence', () => {
  const address = 'Kitchen.Manager@fixture.example.test';
  assert.deepEqual(replyTarget({ claimedSender: address, verifiedSender: address }), { address, verified: true });
  assert.deepEqual(replyTarget({ claimedSender: address, verifiedSender: null }), { address, verified: false });
  assert.equal(replyTarget(null), null);
  assert.equal(replyTarget({ claimedSender: null, verifiedSender: address }), null);
  assert.equal(replyTarget({ claimedSender: address, verifiedSender: 'other@fixture.example.test' }), null);
  for (const claimedSender of ['Name <somewhere@fixture.example.test>', 'duplicate@fixture.example.test, ' + address,
    'Kitchen.Manager@FIXTURE.EXAMPLE.TEST', 'injected@fixture.example.test\r\nLabel: value']) {
    assert.equal(replyTarget({ claimedSender, verifiedSender: null }), null);
  }
});