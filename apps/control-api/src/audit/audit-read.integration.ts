import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CONTROL_ROLE_PRESETS } from '@nventra/types';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { createControlApi } from '../bootstrap.js';
import { appendAuditEvent } from './audit.js';

export async function auditReadCases(t: TestContext, db: PrismaClient, url: string) {
  const runtime = new URL(url); runtime.searchParams.set('options','-c role=control_runtime');
  const key = 'a5'.repeat(32);
  const { app } = await createControlApi({ CONTROL_DATABASE_URL: runtime.href, CONTROL_API_PORT: '4002',
    CONTROL_AUTH_KEY: key, CONTROL_ORIGIN: 'https://control.example.test' });
  t.after(() => app.close()); await app.listen(0,'127.0.0.1');
  const path = await app.getUrl() + '/api/control/v1/audit-events';
  async function session(name: string, grants: string[], byte: number, expired = false) {
    const staffId = randomUUID(), token = Buffer.alloc(32,byte).toString('base64url');
    await db.staff.create({ data: { id: staffId, email: name + '@example.test', passwordHash: 'inert', grants } });
    const digest = createHmac('sha256',key).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId, digest, verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)) } });
    return '__Host-control_staff=' + token;
  }
  const reader = await session('audit-exclusive',['cc.audit.read'],65);
  const get = (query = '', cookie = reader) => fetch(path + query,{ headers: { cookie } });
  await t.test('allows verified audit readers and denies missing, expired and sales sessions', async () => {
    assert.equal((await get('','')).status,401);
    assert.equal((await get('',await session('expired-audit',['cc.audit.read'],66,true))).status,401);
    assert.equal((await get('',await session('sales-audit',[...CONTROL_ROLE_PRESETS.SALES],67))).status,403);
    const response = await get();
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(path,{ method:'POST',headers:{ cookie: reader,origin:'https://control.example.test' } })).status,404);
  });
  await t.test('rejects malformed and noncanonical bounded page queries', async () => {
    for (const query of ['limit=0','limit=101','limit=01','limit=1e1','limit=2&limit=3','extra=1',
      'cursor=-1','cursor=0','cursor=0001','cursor=1.5','cursor=9223372036854775808','cursor=1&cursor=2']) {
      assert.equal((await get('?' + query)).status,400,query);
    }
  });
  await t.test('pages exact bigint positions newest first across a concurrent append with only safe metadata', async () => {
    const sample = await db.auditEvent.findFirstOrThrow();
    const base = 9007199254740992n;
    try {
      // An isolated high tip exercises adjacent bigint sequences beyond Number precision.
      await db.auditEvent.create({ data: { ...sample,sequence:base } });
      const add = () => appendAuditEvent(db,{ actorType:'service',actorId:randomUUID(),action:'fixture.audit',
        subjectType:'ticket',subjectId:randomUUID(),requestId:randomUUID(),outcome:'succeeded',changedFields:['priority'] });
      await add(); await add(); await add();
      const first = await (await get('?limit=2')).json() as { items: { sequence: string }[]; nextCursor: string };
      assert.deepEqual(first.items.map(row => row.sequence),[(base+3n).toString(),(base+2n).toString()]);
      assert.equal(first.nextCursor,(base+2n).toString());
      assert.deepEqual(Object.keys(first.items[0]).sort(),['action','actorId','actorType','businessId','changedFields',
        'occurredAtMs','outcome','requestId','sequence','subjectId','subjectType'].sort());
      await add();
      const next = await (await get('?limit=2&cursor='+first.nextCursor)).json() as typeof first;
      assert.deepEqual(next.items.map(row => row.sequence),[(base+1n).toString(),base.toString()]);
      assert.deepEqual(await (await get('?cursor=1')).json(), { items:[], nextCursor:null });
    } finally { await db.auditEvent.deleteMany({ where:{ sequence:{ gte:base } } }); }
  });
}
