import {
  effectivePermissions,
  type PermissionSource,
} from './effective-permissions';
import { permissionSatisfied } from '@nventra/types';

const NOW = new Date('2026-11-03T10:00:00Z');
const base = (
  over: PermissionSource['permissionOverrides'] = [],
): PermissionSource => ({
  role: {
    permissions: [
      { permission: { key: 'orders.create' } },
      { permission: { key: 'bills.print' } },
    ],
  },
  permissionOverrides: over,
});
const ov = (
  effect: 'GRANT' | 'DENY',
  key: string,
  expiresAt: Date | null = null,
) => ({
  effect,
  expiresAt,
  permission: { key },
});

describe('effectivePermissions', () => {
  it('honours a view DENY over an implied view while preserving manage', () => {
    const user: PermissionSource = {
      role: { permissions: [{ permission: { key: 'menu.manage' } }] },
      permissionOverrides: [ov('DENY', 'menu.view')],
    };
    const permissions = effectivePermissions(user, NOW);
    expect(permissionSatisfied(permissions, 'menu.view')).toBe(false);
    expect(permissionSatisfied(permissions, 'menu.manage')).toBe(true);
  });

  it('keeps implied views when DENY expires', () => {
    const user: PermissionSource = {
      role: { permissions: [{ permission: { key: 'tables.manage' } }] },
      permissionOverrides: [ov('DENY', 'tables.view', new Date(0))],
    };
    expect(
      permissionSatisfied(effectivePermissions(user, NOW), 'tables.view'),
    ).toBe(true);
  });
  it('returns role permissions when there are no overrides', () => {
    expect(effectivePermissions(base(), NOW).sort()).toEqual([
      'bills.print',
      'orders.create',
    ]);
    expect(effectivePermissions({ role: base().role }, NOW)).toHaveLength(2);
  });
  it('adds GRANTed permissions', () => {
    expect(
      effectivePermissions(base([ov('GRANT', 'reports.access')]), NOW),
    ).toContain('reports.access');
  });
  it('removes DENYed role permissions', () => {
    expect(
      effectivePermissions(base([ov('DENY', 'bills.print')]), NOW),
    ).not.toContain('bills.print');
  });
  it('DENY wins over a GRANT of the same key', () => {
    const keys = effectivePermissions(
      base([ov('GRANT', 'x.y'), ov('DENY', 'x.y')]),
      NOW,
    );
    expect(keys).not.toContain('x.y');
  });
  it('ignores expired overrides and honours future ones', () => {
    const past = new Date(NOW.getTime() - 1000);
    const future = new Date(NOW.getTime() + 1000);
    const keys = effectivePermissions(
      base([
        ov('DENY', 'bills.print', past),
        ov('GRANT', 'reports.access', past),
        ov('GRANT', 'data.export', future),
      ]),
      NOW,
    );
    expect(keys).toContain('bills.print');
    expect(keys).not.toContain('reports.access');
    expect(keys).toContain('data.export');
  });
});
