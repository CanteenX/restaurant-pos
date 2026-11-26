import assert from 'node:assert/strict';
import test from 'node:test';
import { portalTicketOpen, portalTicketStaffReply } from '@nventra/types/dist/control-portal-ticket';

const requestKey = '9f07e90b-d0d1-4dba-9abf-1795da5489da';
const draft = { subject: '  Billing question  ', text: 'Please help\r\nThanks.', requestKey };

void test('normalizes portal text and accepts only a scoped outlet hint', () => {
  assert.deepEqual(portalTicketOpen.parse(draft), { ...draft, subject: 'Billing question', text: 'Please help\nThanks.' });
  assert.equal(portalTicketOpen.safeParse({ ...draft, outletId: requestKey }).success, true);
  for (const extra of [{ businessId: requestKey }, { accountId: requestKey }, { ownerId: requestKey }, { visibility: 'staff' }]) {
    assert.equal(portalTicketOpen.safeParse({ ...draft, ...extra }).success, false);
  }
  for (const subject of ['', 'a\nb', 'a\u2028b', 'a'.repeat(241)]) {
    assert.equal(portalTicketOpen.safeParse({ ...draft, subject }).success, false);
  }
});

void test('validates plain staff replies without SMTP or visibility overrides', () => {
  const body = { text: '<b>Plain text</b>', requestKey };
  assert.deepEqual(portalTicketStaffReply.parse(body), body);
  for (const extra of [{ recipient: 'someone@example.test' }, { visibility: 'staff' }, { acknowledgeUnverified: true }]) {
    assert.equal(portalTicketStaffReply.safeParse({ ...body, ...extra }).success, false);
  }
  for (const text of [' ', 'a\u0000b', 'a'.repeat(4001)]) {
    assert.equal(portalTicketStaffReply.safeParse({ ...body, text }).success, false);
  }
});
