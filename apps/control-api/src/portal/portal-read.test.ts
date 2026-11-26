import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { portalBusiness } from './portal-read.ts';

void test('requires the authenticated business and current hosted status for paid resources', async () => {
  const businessId = '10000000-0000-4000-8000-000000000001';
  const tx = (row?: { id: string; displayName: string; hostedStatus: string }) =>
    ({ $queryRaw: () => Promise.resolve(row ? [row] : []) }) as unknown as Prisma.TransactionClient;
  const active = { id: businessId, displayName: 'Business', hostedStatus: 'active' };
  assert.deepEqual(await portalBusiness(tx(active), businessId, true), active);
  const suspended = { ...active, hostedStatus: 'suspended' };
  assert.deepEqual(await portalBusiness(tx(suspended), businessId), suspended);
  await assert.rejects(portalBusiness(tx(suspended), businessId, true), {status: 403});
  await assert.rejects(portalBusiness(tx(), businessId), {status: 404});
  await assert.rejects(portalBusiness(tx(active), 'other'), {status: 404});
});
