const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

module.exports = async function resetFixturePeerWindow() {
  const port = process.env.CONTROL_QA_DB_PORT;
  const key = process.env.CONTROL_AUTH_KEY;
  const fixture = 'postgresql://fixture:fixture@127.0.0.1:' + port + '/fixture?options=-c%20role%3Dcontrol_runtime';
  assert.ok(/^[0-9]{5}$/.test(port) && Number(port) >= 32768 && Number(port) <= 65535 &&
    process.env.CONTROL_DATABASE_URL === fixture && key, 'This test requires the disposable Control QA fixture');
  const { PrismaClient } = require('../../apps/control-api/node_modules/.prisma/control-client');
  const db = new PrismaClient({ datasourceUrl: fixture });
  try {
    const [{ role }] = await db.$queryRaw`SELECT current_user AS role`;
    assert.equal(role, 'control_runtime');
    const peer = (stage) => createHmac('sha256', key).update(stage + ':peer\0' + '127.0.0.1').digest('hex');
    await db.$executeRaw`DELETE FROM control.auth_limit WHERE bucket IN (${peer('challenge')}, ${peer('factor')})`;
  } finally {
    await db.$disconnect();
  }
};
