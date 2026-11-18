import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideHostedPatch, hostedAccessPatch, hostedAccessTag } from './hosted-access-policy.ts';

const prior = 'cdb725ea-6dea-4106-9886-56224090adef';
const owner = '599c2793-bf4b-4cd7-b886-0d44225adbcd';
const other = '6b95c1ef-eb48-4d7c-bf2c-4c869a63ce0b';
const patch = { status: 'suspended', reason: 'Pilot invoice overdue', requestKey: prior } as const;

void test('accepts a strict normalised hosted-access command', () => {
  assert.deepEqual(hostedAccessPatch.parse({ ...patch, reason: ' Pilot invoice overdue ' }), patch);
  for (const bad of [{ ...patch, reason: '' }, { ...patch, reason: 'line\nbreak' }, { ...patch, reason: 'x'.repeat(241) },
    { ...patch, status: 'disabled' }, { ...patch, businessId: prior }, { ...patch, requestKey: 'wrong' }]) {
    assert.equal(hostedAccessPatch.safeParse(bad).success, false);
  }
});

void test('requires one canonical strong revision tag from the preceding read', () => {
  assert.equal(hostedAccessTag.parse('"0"'), '0');
  assert.equal(hostedAccessTag.parse('"' + prior + '"'), prior);
  for (const bad of [undefined, '*', prior, 'W/"0"', '"0", "0"', '"' + prior.toUpperCase() + '"']) {
    assert.equal(hostedAccessTag.safeParse(bad).success, false);
  }
});

void test('accepts safe retries before checking the current revision', () => {
  const existing = { actorId: owner, status: patch.status, reason: patch.reason };
  assert.equal(decideHostedPatch(owner, patch, '0', other, existing), 'replay');
  assert.equal(decideHostedPatch(other, patch, '0', other, existing), 'conflict');
  assert.equal(decideHostedPatch(owner, { ...patch, reason: 'Different reason' }, '0', other, existing), 'conflict');
  assert.equal(decideHostedPatch(owner, { ...patch, status: 'active' }, '0', other, existing), 'conflict');
});

void test('applies a fresh command only against its current revision', () => {
  assert.equal(decideHostedPatch(owner, patch, '0', '0'), 'apply');
  assert.equal(decideHostedPatch(owner, patch, prior, prior), 'apply');
  assert.equal(decideHostedPatch(owner, patch, '0', other), 'stale');
});
