const { randomUUID } = require('node:crypto');
const { sealSecret } = require('../../packages/types/dist/node/totp');

module.exports = async function seedHelpdesk(db, passwordHash) {
  const staff = [
    ['support@example.test', ['cc.business.read', 'cc.ticket.read', 'cc.ticket.manage']],
    ['ticket-reader@example.test', ['cc.business.read', 'cc.ticket.read']],
    ['reply-staff@example.test', ['cc.ticket.read', 'cc.ticket.reply']],
    ...['pagination', 'refresh', 'reply', 'queue'].map((action) =>
      ['reply-' + action + '@example.test', ['cc.ticket.read', 'cc.ticket.reply']]),
    ['roundtrip-staff@example.test', ['cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply']],
    ['roundtrip-reader@example.test', ['cc.ticket.read']],
  ];
  await db.staff.createMany({ data: staff.map(([email, grants]) => {
    const id = randomUUID();
    return { id, email, grants, passwordHash,
      encryptedSeed: sealSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', process.env.CONTROL_AUTH_KEY + id) };
  }) });

  const ticket = await db.ticket.create({ data: { id: randomUUID(), subject: 'Printer support', priority: 'high' } });
  await db.ticketMessage.create({ data: { id: randomUUID(), ticketId: ticket.id, sequence: 1,
    direction: 'inbound', visibility: 'public', text: '<b>Receipt printer offline</b>\nPlease help.' } });
};