import assert from 'node:assert/strict';
import test from 'node:test';

import { OUTBOX_ATTEMPT_LIMIT, OUTBOX_DAILY_LIMIT, resolveOutboxDelivery } from './outbox-policy.ts';

const id = '<stable@fixture.example.test>';

void test('accepts only positive delivery evidence for the expected stable message ID', () => {
  assert.deepEqual(resolveOutboxDelivery({ status: 'sent', messageId: id }, 1, id), { state: 'sent' });
  assert.deepEqual(resolveOutboxDelivery({ status: 'sent', messageId: '<other@fixture.example.test>' }, 1, id),
    { state: 'held' });
});

void test('backs off only after positive retryable 4xx rejections, up to the attempt cap', () => {
  const rejection = { status: 'rejected', responseCode: 451, retryable: true } as const;
  assert.equal(OUTBOX_ATTEMPT_LIMIT, 3);
  assert.equal(OUTBOX_DAILY_LIMIT, 100);
  assert.deepEqual(resolveOutboxDelivery(rejection, 1, id), { state: 'queued', retryAfterSeconds: 60 });
  assert.deepEqual(resolveOutboxDelivery(rejection, 2, id), { state: 'queued', retryAfterSeconds: 300 });
  assert.deepEqual(resolveOutboxDelivery(rejection, 3, id), { state: 'failed' });
});

void test('keeps ambiguous or contradictory outcomes held and rejects invalid attempt indices', () => {
  assert.deepEqual(resolveOutboxDelivery({ status: 'ambiguous' }, 1, id), { state: 'held' });
  for (const attempt of [0, 1.5, 4, NaN]) {
    assert.deepEqual(resolveOutboxDelivery({ status: 'sent', messageId: id }, attempt, id), { state: 'held' });
  }
  for (const [responseCode, retryable] of [[450, false], [551, true], [399, true], [600, false], [450.5, true]] as const) {
    assert.deepEqual(resolveOutboxDelivery({ status: 'rejected', responseCode, retryable }, 1, id), { state: 'held' });
  }
});

void test('stops on definite permanent rejection and locally invalid sends', () => {
  assert.deepEqual(resolveOutboxDelivery({ status: 'rejected', responseCode: 550, retryable: false }, 1, id),
    { state: 'failed' });
  assert.deepEqual(resolveOutboxDelivery({ status: 'invalid' }, 1, id), { state: 'failed' });
});