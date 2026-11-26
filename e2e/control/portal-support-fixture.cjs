const { randomUUID } = require('node:crypto');
const { sealSecret } = require('../../packages/types/dist/node/totp');

// Called only by seed.cjs after it validates the disposable loopback database.
module.exports = async function seedPortalSupport(db, passwordHash) {
  const support = ['cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'];
  const directory = ['cc.business.read', 'cc.business.manage', 'cc.portal.read', 'cc.portal.create', 'cc.portal.manage'];
  const access = ['cc.hosted.read', 'cc.hosted.manage'];
  await db.staff.createMany({ data: [
    ['portal-support-staff@example.test', [...directory, ...access, ...support]],
    ['portal-recovery-staff@example.test', [...directory, ...access, 'cc.billing.read', 'cc.billing.manage']],
  ].map(([email, grants]) => {
    const id = randomUUID();
    return { id, email, grants, passwordHash,
      encryptedSeed: sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', process.env.CONTROL_AUTH_KEY + id) };
  }) });

  // Directory lists page by random id, so every fixture business needs an outlet: an existing spec
  // takes the first business and its first outlet.
  const business = async (name) => {
    const created = await db.business.create({ data: { id: randomUUID(), legalName: name, displayName: name } });
    await db.outlet.create({ data: { id: randomUUID(), businessId: created.id, displayName: name + ' Outlet', timeZone: 'UTC' } });
    return created;
  };
  const [customer, other] = await Promise.all([business('Portal Support Bistro'), business('Portal Other Cafe')]);
  for (const [email, business] of [
    ['portal-ticket-colleague@example.test', customer],
    ['portal-ticket-other@example.test', other],
  ]) {
    await db.$executeRaw`INSERT INTO control.portal_account(id,business_id,email,status,password_hash)
      VALUES (${randomUUID()}::uuid,${business.id}::uuid,${email},'active',${passwordHash})`;
  }
};
