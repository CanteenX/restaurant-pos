import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_PERMISSIONS } from '@nventra/types';
import { portalControllers, staffControllers } from '../bootstrap.js';
import { listControllerRoutes, ROUTE_ACCESS } from './role-route-matrix.js';

const routes = listControllerRoutes([...staffControllers, ...portalControllers]);
const accessClasses = new Set<string>(['public', 'staff-session', 'portal-session', ...CONTROL_PERMISSIONS]);

void test('every control-api route is derived from the controllers and declares an access class', () => {
  assert.ok(routes.length >= 50, 'route discovery found the controllers (' + routes.length + ')');
  const undeclared = routes.filter((route) => !(route in ROUTE_ACCESS));
  assert.deepEqual(undeclared, [], 'routes without a declared permission');
});

void test('the declared table has no stale routes and only known access classes', () => {
  assert.deepEqual(Object.keys(ROUTE_ACCESS).filter((route) => !routes.includes(route)), []);
  for (const [route, { access }] of Object.entries(ROUTE_ACCESS)) assert.ok(accessClasses.has(access), route);
  assert.equal(new Set(routes).size, routes.length, 'no duplicate route registrations');
});

void test('every permission-gated route can be driven by the HTTP matrix', () => {
  for (const [route, { access, send }] of Object.entries(ROUTE_ACCESS)) {
    const gated = access !== 'public' && access !== 'staff-session' && access !== 'portal-session';
    assert.equal(typeof send === 'function', gated, route);
  }
});

void test('every billing, hosted, audit, staff and portal-management permission is exercised by some route', () => {
  const used = new Set(Object.values(ROUTE_ACCESS).map((r) => r.access));
  for (const key of CONTROL_PERMISSIONS) assert.ok(used.has(key), 'no route requires ' + key);
});
