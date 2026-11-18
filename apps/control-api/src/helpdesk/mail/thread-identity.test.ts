import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeThreadIdentity } from './thread-identity.ts';

void test('prioritizes direct parents, then newest references, without repeats or self-links', () => {
  assert.deepEqual(
    normalizeThreadIdentity({
      messageId: ' \t<Child.1@Example.test>\t',
      inReplyTo: '<parent@example.test><other@example.test>',
      references:
        '<root@example.test>\r\n\t<other@example.test> <parent@example.test>\r\n' +
        ' <nearest@example.test> <Child.1@Example.test>',
    }),
    {
      messageId: '<Child.1@Example.test>',
      candidates: [
        '<parent@example.test>',
        '<other@example.test>',
        '<nearest@example.test>',
        '<root@example.test>',
      ],
    },
  );
});

void test('preserves case and accepts modern domain literals', () => {
  assert.deepEqual(
    normalizeThreadIdentity({
      messageId: '<receipt+1@[IPv6:2001:db8::1]>',
      references: '<Root@Example.test> <root@example.test>',
    }),
    {
      messageId: '<receipt+1@[IPv6:2001:db8::1]>',
      candidates: ['<root@example.test>', '<Root@Example.test>'],
    },
  );
});

void test('rejects malformed IDs, injected lines, and angle brackets within prose or comments', () => {
  for (const value of [
    '<id>',
    '<.id@example.test>',
    '<id..id@example.test>',
    '<id@.example.test>',
    '<id@example.test.>',
    '<id @example.test>',
    '<id@example.test>\r\nSubject: <injected@example.test>',
    '<id@example.test>\n <injected@example.test>',
    '<id@example.test>\u0000',
    '<id@example.test>\u2028',
    '(<id@example.test>)',
    '"<id@example.test>"',
    '<valid@example.test> <broken>',
  ]) {
    assert.deepEqual(
      normalizeThreadIdentity({ messageId: value, references: value }),
      { messageId: null, candidates: [] },
      value,
    );
  }
});

void test('never infers identity from the subject and isolates invalid fields', () => {
  const headers = {
    subject: 'Re: <injected@example.test> [Ticket #123]',
    messageId: '<one@example.test> <two@example.test>',
    references: '<valid@example.test>',
  };
  assert.deepEqual(normalizeThreadIdentity(headers), {
    messageId: null,
    candidates: ['<valid@example.test>'],
  });
  assert.deepEqual(normalizeThreadIdentity({ ...headers, references: ' \t' }), {
    messageId: null,
    candidates: [],
  });
  assert.deepEqual(normalizeThreadIdentity({}), { messageId: null, candidates: [] });
});

void test('bounds individual IDs and entire fields before returning any candidates', () => {
  const maxId = '<' + 'a'.repeat(239) + '@example.test>';
  const oversizedId = '<a' + maxId.slice(1);
  const oversizedField = '<valid@example.test> '.repeat(500);
  assert.equal(maxId.length, 254);
  assert.equal(normalizeThreadIdentity({ messageId: maxId }).messageId, maxId);
  assert.deepEqual(
    normalizeThreadIdentity({
      messageId: oversizedId,
      inReplyTo: oversizedField,
      references: '<fallback@example.test>',
    }),
    {
      messageId: null,
      candidates: ['<fallback@example.test>'],
    },
  );
});
