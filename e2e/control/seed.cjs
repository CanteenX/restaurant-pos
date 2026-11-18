function fail() {
  process.stderr.write('Control browser fixture seed failed.\n');
  process.exitCode = 1;
}

// The launcher passes the dynamic port from its own disposable Docker container.
const port = process.argv[2];
const fixtureUrl = 'postgresql://fixture:fixture@127.0.0.1:' + port + '/fixture';
if (process.argv.length !== 3 || !/^[0-9]{5}$/.test(port) || Number(port) < 32768 ||
    Number(port) > 65535 || process.env.CONTROL_DATABASE_URL !== fixtureUrl) {
  fail();
  return;
}
const { createHash, randomUUID } = require('node:crypto');
const apiModules = '../../apps/control-api/node_modules/';
const { PrismaClient } = require(apiModules + '.prisma/control-client');
const { hash } = require(apiModules + 'bcrypt');
const { sealSecret } = require('../../packages/types/dist/node/totp');
const db = new PrismaClient({ datasourceUrl: fixtureUrl });

async function seed() {
  const passwordHash = await hash('browser fixture passphrase', 12);
  await require('./helpdesk-fixture.cjs')(db, passwordHash);
  await require('./audit-fixture.cjs')(db, passwordHash);
  const ownerId = randomUUID(), readerId = randomUUID();
  const read = ['cc.business.read', 'cc.plan.read'];
  const encryptedSeed = sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', process.env.CONTROL_AUTH_KEY + readerId);
  await db.staff.createMany({ data: [
    { id: ownerId, email: 'owner@example.test', passwordHash, grants: [...read, 'cc.business.manage', 'cc.plan.manage'] },
    { id: readerId, email: 'reader@example.test', passwordHash, grants: read, encryptedSeed },
  ] });
  await db.staffEnrollmentProof.create({ data: { staffId: ownerId, expiresAt: new Date(Date.now() + 900_000),
    digest: createHash('sha256').update(Buffer.alloc(32, 42)).digest() } });
  const business = await db.business.create({ data: {
    id: randomUUID(), legalName: 'Fixture Bistro Pvt Ltd', displayName: 'Fixture Bistro',
  } });
  await db.outlet.create({ data: { id: randomUUID(), businessId: business.id, displayName: 'Market Outlet', timeZone: 'UTC' } });
}

void seed().finally(() => db.$disconnect()).catch(fail);
