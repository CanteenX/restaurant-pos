const { randomUUID } = require('node:crypto');
const { CONTROL_PERMISSIONS } = require('../../packages/types/dist/permissions');
const { sealSecret } = require('../../packages/types/dist/node/totp');
const { appendAuditEvent } = require('../../apps/control-api/dist/audit/audit');

module.exports = async function seedAudit(db, passwordHash) {
  for (const [name,grants] of [['audit-owner',CONTROL_PERMISSIONS],['audit-marketing',['cc.business.read','cc.business.manage','cc.plan.read','cc.portal.read','cc.portal.manage']],['audit-reader',['cc.audit.read']]]) {
    const id = randomUUID();
    await db.staff.create({ data: { id, email: name + '@example.test', passwordHash, grants: [...grants],
      encryptedSeed: sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', process.env.CONTROL_AUTH_KEY + id) } });
  }
  for (let i = 1; i <= 24; i++) {
    await appendAuditEvent(db,{ actorType:'system',actorId:randomUUID(),action:'fixture.audit.' + i,
      subjectType:'ticket',subjectId:randomUUID(),requestId:randomUUID(),outcome:'succeeded' });
  }
};
