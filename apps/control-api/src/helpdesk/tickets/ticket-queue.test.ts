import assert from 'node:assert/strict';
import test from 'node:test';
import { ticketListPage, ticketPatch } from '@nventra/types';

const id = '9f07e90b-d0d1-4dba-9abf-1795da5489da';
const oldest = { businessId: id, outletId: id, sort: 'oldest-unanswered', limit: '2' };

void test('validates queue scope and separates cursor formats', () => {
  const cursor = '2026-01-03T00:00:00.000Z~' + id;
  assert.equal(ticketListPage.safeParse({ ...oldest, cursor }).success, true);
  assert.equal(ticketListPage.safeParse({ ...oldest, cursor: id }).success, false);
  assert.equal(ticketListPage.safeParse({ outletId: id }).success, false);
  assert.equal(ticketListPage.safeParse({ cursor }).success, false);
  assert.equal(ticketListPage.safeParse({ cursor: id }).success, true);
});

void test('validates explicit confirmation as metadata for a business link', () => {
  assert.equal(ticketPatch.safeParse({ businessId: id, confirmedBusinessLink: true }).success, true);
  assert.equal(ticketPatch.safeParse({ businessId: id, confirmedBusinessLink: false }).success, false);
  assert.equal(ticketPatch.safeParse({ confirmedBusinessLink: true }).success, false);
});
