import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMailJobConfig } from './mail-job-config.ts';
import { runMailJob, type MailJobSession } from './run-mail-job.ts';

const enabled = {
  CONTROL_MAIL_ENABLED: 'true',
  CONTROL_MAIL_RETENTION_DAYS: '90',
  CONTROL_MAIL_DATABASE_URL: 'postgresql://mail_worker@db.example.test/control',
  CONTROL_GMAIL_USER: 'fixture@example.test',
  CONTROL_GMAIL_APP_PASSWORD: 'x'.repeat(16),
};

void test('keeps mail disabled with absent or false opt-in and opens no worker session', async () => {
  const neverOpen = () => { assert.fail('Disabled mail opened a worker'); };
  assert.deepEqual(readMailJobConfig({}), { enabled: false });
  assert.deepEqual(readMailJobConfig({ CONTROL_MAIL_ENABLED: 'false', CONTROL_MAIL_DATABASE_URL: 'invalid' }), { enabled: false });
  for (const env of [{}, { ...enabled, CONTROL_MAIL_ENABLED: 'false' }]) {
    assert.equal(await runMailJob('inbox', env, neverOpen), 'disabled');
  }
});

void test('requires explicit valid opt-in, retention, worker connection and Gmail configuration', () => {
  const malformed: NodeJS.ProcessEnv[] = [
    { CONTROL_MAIL_ENABLED: '' }, { CONTROL_MAIL_ENABLED: 'TRUE' }, { CONTROL_MAIL_ENABLED: '1' },
    ...[undefined, '', '0', '-1', '01', '3.5', '1e2', '9007199254740992', '12345678901234567'].map((days) => ({
      ...enabled, CONTROL_MAIL_RETENTION_DAYS: days,
    })),
    ...[undefined, 'not-a-uri', 'https://mail_worker@db.example.test/control',
      'postgresql://db.example.test/control', 'postgresql://mail_worker@db.example.test',
      'postgresql://mail_worker@db.example.test:0/control', 'postgresql://invalid%ZZ@db.example.test/control',
      'postgresql://mail_worker@db.example.test/control#fragment'].map((url) => ({
      ...enabled, CONTROL_MAIL_DATABASE_URL: url,
    })),
    { ...enabled, CONTROL_GMAIL_USER: undefined },
    { ...enabled, CONTROL_GMAIL_APP_PASSWORD: 'bad-fixture-value' },
  ];
  for (const env of malformed) assert.throws(() => readMailJobConfig(env), /^Error: Invalid Control mail job configuration$/);
  const parsed = readMailJobConfig(enabled);
  assert.equal(parsed.enabled && parsed.retentionDays, 90);
});

void test('rejects aliases for a staff or operator PostgreSQL login and never falls back to their URLs', () => {
  for (const key of ['CONTROL_DATABASE_URL', 'CONTROL_OPERATOR_DATABASE_URL']) {
    const alias = 'postgres://mail_worker@DB.example.test:5432/control?pool_timeout=1';
    const staffEnv = { ...enabled, [key]: alias };
    assert.throws(() => readMailJobConfig(staffEnv), /^Error: Invalid Control mail job configuration$/);
    assert.throws(() => readMailJobConfig({ ...staffEnv, CONTROL_MAIL_DATABASE_URL: undefined }), /^Error: Invalid Control mail job configuration$/);
  }
});

void test('opens one verified worker and selects only the requested one-shot callback before cleanup', async () => {
  const calls: string[] = [];
  const session: MailJobSession = {
    inbox: () => { calls.push('inbox'); return Promise.resolve(); },
    outbox: () => { calls.push('outbox'); return Promise.resolve(); },
    close: () => { calls.push('close'); return Promise.resolve(); },
  };
  for (const mode of ['inbox', 'outbox']) {
    calls.length = 0;
    const result = await runMailJob(mode, enabled, (config, signal) => {
      assert.equal(config.retentionDays, 90);
      assert.equal(signal.aborted, false);
      calls.push('verified');
      return Promise.resolve(session);
    });
    assert.equal(result, 'complete');
    assert.deepEqual(calls, ['verified', mode, 'close']);
  }
});

void test('rejects invalid configuration and modes before worker initialization', async () => {
  let opens = 0;
  const unexpected = () => { opens++; return Promise.reject(new Error('fixture')); };
  assert.equal(await runMailJob('unexpected', enabled, unexpected), 'invalid-mode');
  assert.equal(await runMailJob('outbox', { ...enabled, CONTROL_MAIL_RETENTION_DAYS: undefined }, unexpected), 'invalid-configuration');
  assert.equal(opens, 0);
});

void test('redacts failures from worker verification, execution and cleanup', async () => {
  const failure = () => Promise.reject(new Error('synthetic connection detail'));
  const work = () => Promise.resolve();
  for (const open of [
    failure,
    () => Promise.resolve({ inbox: failure, outbox: work, close: work }),
    () => Promise.resolve({ inbox: work, outbox: work, close: failure }),
  ]) assert.equal(await runMailJob('inbox', enabled, open), 'failed');

  let closed = false;
  const session = { inbox: failure, outbox: work, close: () => { closed = true; return Promise.resolve(); } };
  assert.equal(await runMailJob('inbox', enabled, () => Promise.resolve(session)), 'failed');
  assert.equal(closed, true);
});

void test('cooperatively cancels a run and closes resources without exposing the reason', async () => {
  const aborted = new AbortController();
  aborted.abort(new Error('synthetic private reason'));
  const neverOpen = () => { assert.fail('Aborted mail opened a worker'); };
  assert.equal(await runMailJob('inbox', enabled, neverOpen, aborted.signal), 'interrupted');

  const active = new AbortController();
  let closed = false;
  const inbox = (signal: AbortSignal) => {
    active.abort(new Error('synthetic private reason'));
    assert.equal(signal.aborted, true);
    signal.throwIfAborted();
    return Promise.resolve();
  };
  const close = () => { closed = true; return Promise.resolve(); };
  assert.equal(await runMailJob('inbox', enabled, () => Promise.resolve({ inbox, outbox: inbox, close }), active.signal), 'interrupted');
  assert.equal(closed, true);

  const opening = new AbortController();
  closed = false;
  assert.equal(await runMailJob('inbox', enabled, () => {
    opening.abort();
    return Promise.resolve({ inbox: () => { assert.fail('Aborted startup ran mail work'); }, outbox: inbox, close });
  }, opening.signal), 'interrupted');
  assert.equal(closed, true);
});

void test('refuses diagnostic startup flags before importing a database or transport', () => {
  const trap = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (id, ...args) {
      if (/scheduled-mail-worker|control-client/.test(id)) throw new Error('Worker module loaded');
      return load.call(this, id, ...args);
    };
    require('./' + process.argv[1]);
  `;
  for (const [flag, value] of [['DEBUG','prisma:*'],['RUST_LOG','trace'],['NODE_DEBUG','net,tls']]) {
    const result = spawnSync(process.execPath, ['-e', trap, '--', 'dist/helpdesk/mail/mail-main.js', 'inbox'], {
      encoding: 'utf8', timeout: 5_000, env: { ...process.env, DEBUG: '', RUST_LOG: '', NODE_DEBUG: '',
        CONTROL_MAIL_ENABLED: 'false', CONTROL_MAIL_DATABASE_URL: '', [flag]: value },
    });
    assert.deepEqual([result.status, result.stdout, result.stderr],
      [1, '', 'Control mail job did not complete (invalid-configuration).\n']);
  }
});

void test('operator scheduler has a hard termination bound for a worker that ignores cancellation', () => {
  const runbook = readFileSync('operator/mail-scheduler.md', 'utf8');
  const limit = /timeout --kill-after=(\d+)s (\d+)s/.exec(runbook);
  assert.ok(limit);
  assert.equal(Number(limit[1]) + Number(limit[2]), 120);
  assert.match(runbook, /ExecutionTimeLimit.*PT2M/);
  assert.match(runbook, /AllowHardTerminate/);
});
