import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activationInput, loginInput, portalAccountInput, portalCookie, portalDigest, portalSetCookie,
  portalToken, readPortalConfig } from './portal-identity-policy.ts';

const fixtureToken = Buffer.alloc(32, 33).toString('base64url');
const password = 'fixture longer passphrase';
const email = 'Some.Client@example.test';
const fixtureKey = 'a6'.repeat(32);

void test('validates separate strict provisioning, activation, and login bodies', () => {
  assert.deepEqual(portalAccountInput.parse({ email: ' ' + email + ' ' }), { email: email.toLowerCase() });
  assert.deepEqual(activationInput.parse({ code: fixtureToken, password }), { code: fixtureToken, password });
  assert.deepEqual(loginInput.parse({ email, password }), { email: email.toLowerCase(), password });
  assert.equal(loginInput.safeParse({ email, password, businessId: 'fixture-route' }).success, false);
  assert.equal(portalAccountInput.safeParse({ email, role: 'owner' }).success, false);
  assert.equal(activationInput.safeParse({ code: fixtureToken, password: 'short' }).success, false);
  assert.equal(loginInput.safeParse({ email, password: 'é'.repeat(37) }).success, false);
  assert.equal(activationInput.safeParse({ code: fixtureToken.slice(0, -1) + 'B', password }).success, false);
});

void test('isolates cookie and digest purposes, and ignores other application cookies', () => {
  const token = portalToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(portalCookie('__Host-control_staff=' + token), undefined);
  assert.equal(portalCookie('host_pos=' + token), undefined);
  assert.equal(portalCookie('__Host-control_portal=' + token), token);
  assert.equal(portalCookie('__Host-control_portal=' + token + '; __Host-control_portal=' + token), undefined);
  assert.equal(portalCookie('__Host-control_portal=' + fixtureToken.slice(0, -1) + 'B'), undefined);
  assert.match(portalSetCookie(token), /; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.match(portalSetCookie(), /^__Host-control_portal=; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=0$/);
  const digest = portalDigest(fixtureKey, 'activation', token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, portalDigest(fixtureKey, 'activation', token));
  assert.notEqual(digest, portalDigest(fixtureKey, 'session', token));
  assert.notEqual(digest, portalDigest(fixtureKey, 'rate:activation:peer', token));
  assert.notEqual(digest, portalDigest('a7'.repeat(32), 'activation', token));
});

void test('enables portal authentication only with complete separate configuration and a canonical HTTPS origin', () => {
  assert.equal(readPortalConfig({ CONTROL_ORIGIN: 'https://control.example.test' }), undefined);
  const env = { CONTROL_PORTAL_DATABASE_URL: 'postgresql://portal_fixture@db.example.test/control',
    CONTROL_PORTAL_AUTH_KEY: fixtureKey, CONTROL_AUTH_KEY: 'a5'.repeat(32), CONTROL_ORIGIN: 'https://control.example.test' };
  assert.deepEqual(readPortalConfig(env), { url: env.CONTROL_PORTAL_DATABASE_URL, key: fixtureKey, origin: env.CONTROL_ORIGIN });
  for (const change of [{ CONTROL_PORTAL_AUTH_KEY: undefined }, { CONTROL_PORTAL_AUTH_KEY: env.CONTROL_AUTH_KEY },
    { CONTROL_PORTAL_DATABASE_URL: undefined }, { CONTROL_PORTAL_DATABASE_URL: 'https://safe.example.test/control' },
    { CONTROL_PORTAL_DATABASE_URL: 'postgresql://db.example.test/control' },
    { CONTROL_ORIGIN: 'http://control.example.test' }, { CONTROL_ORIGIN: 'https://control.example.test/path' },
    { DEBUG: 'prisma:*' }, { RUST_LOG: 'debug' }, { NODE_DEBUG: 'net' },
    { CONTROL_DATABASE_URL: 'postgres://portal_fixture@DB.example.test:5432/control?pool_timeout=1' }]) {
    assert.throws(() => readPortalConfig({ ...env, ...change }), /^Error: Invalid Control portal authentication configuration$/);
  }
});
