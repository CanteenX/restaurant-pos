import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PortalDownloads, readPortalResources } from './portal-downloads.ts';

void test('keeps downloads disabled by default and accepts only a canonical local root and single support address', async () => {
  const config = readPortalResources({});
  assert.equal(config.supportEmail, 'nventra01@gmail.com');
  assert.match(config.paymentInstructions, /invoice/i);
  assert.deepEqual(await new PortalDownloads(config.directory).list(), []);
  for (const directory of ['relative', '/', '//remote/fixture', '../downloads']) {
    assert.throws(() => readPortalResources({ CONTROL_PORTAL_DOWNLOAD_DIR: directory }), /Invalid portal resources/);
  }
  assert.throws(() => readPortalResources({ CONTROL_PORTAL_SUPPORT_EMAIL: 'a@example.test,b@example.test' }), /Invalid portal resources/);
  assert.equal(readPortalResources({ CONTROL_PORTAL_SUPPORT_EMAIL: 'support@example.test' }).supportEmail, 'support@example.test');
});

void test('serves only named regular release files and rejects aliases, traversal and unexpected filenames', async (t) => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'control-portal-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'releases'), outside = path.join(directory, 'other');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'OrderRestro.msix'), 'synthetic installer');
  await writeFile(path.join(root, 'private.txt'), 'synthetic private file');
  await writeFile(path.join(outside, 'OrderRestro.msix'), 'outside fixture');
  const aliases = path.join(directory, 'alias');
  await symlink(outside, aliases, 'junction');
  await symlink(outside, path.join(root, 'OrderRestro-update.msix'), 'junction');
  const downloads = new PortalDownloads(root);
  assert.deepEqual(await downloads.list(), [{id:'windows-installer',label:'Windows installer'}]);
  for (const id of ['../private.txt','..%2fprivate.txt','OrderRestro.msix','__proto__','windows-update']) {
    assert.equal(await downloads.open(id), null);
  }
  assert.deepEqual(await new PortalDownloads(aliases).list(), []);
  const file = await downloads.open('windows-installer');
  assert.ok(file);
  try {
    assert.equal(file.name, 'OrderRestro.msix');
    assert.equal(file.length, 19);
    assert.equal(await file.handle.readFile('utf8'), 'synthetic installer');
  } finally { await file.handle.close(); }
});
