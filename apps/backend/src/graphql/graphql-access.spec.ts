import type { GraphqlContext } from './graphql-context';
import {
  ACCESS,
  hasAccess,
  menuVisibility,
  orderVisibility,
} from './graphql-access';

const keyCtx = (scopes: string[], branchId: string | null = null) =>
  ({
    restaurantId: 'r1',
    branchId,
    principal: { kind: 'integration', id: 'k1', scopes },
  }) as GraphqlContext;
const staffCtx = (permissions: string[]) =>
  ({
    restaurantId: 'r1',
    branchId: null,
    principal: { kind: 'staff', id: 'u1', permissions },
  }) as GraphqlContext;

describe('GraphQL permission mapping', () => {
  it.each([
    ['menu', 'menu:read', 'menu.view'],
    ['orders', 'orders:read', 'orders.create'],
    ['orderCustomer', 'orders:read_customer', 'customers.manage'],
    ['customers', 'customers:read', 'customers.manage'],
  ] as const)('%s needs scope %s or permission %s', (field, scope, perm) => {
    expect(ACCESS[field]).toEqual({ scope, permission: perm });
    expect(hasAccess(keyCtx([scope]), ACCESS[field])).toBe(true);
    expect(hasAccess(staffCtx([perm]), ACCESS[field])).toBe(true);
    expect(hasAccess(keyCtx([]), ACCESS[field])).toBe(false);
    expect(hasAccess(staffCtx([]), ACCESS[field])).toBe(false);
  });

  it('never lets a key use a staff permission name, or staff a scope', () => {
    expect(hasAccess(keyCtx(['menu.view']), ACCESS.menu)).toBe(false);
    expect(hasAccess(staffCtx(['menu:read']), ACCESS.menu)).toBe(false);
  });

  it('honours implied permissions for staff (menu.manage implies menu.view)', () => {
    expect(hasAccess(staffCtx(['menu.manage']), ACCESS.menu)).toBe(true);
  });

  it('keeps menu cost price staff-only, behind menu.manage', () => {
    expect(ACCESS.menuCost).toEqual({ permission: 'menu.manage' });
    expect(hasAccess(staffCtx(['menu.manage']), ACCESS.menuCost)).toBe(true);
    expect(hasAccess(staffCtx(['menu.view']), ACCESS.menuCost)).toBe(false);
    // No scope maps to cost price: every key is refused, whatever it holds.
    expect(
      hasAccess(
        keyCtx(['menu:read', 'orders:read', 'customers:read']),
        ACCESS.menuCost,
      ),
    ).toBe(false);
  });

  it('does not let orders:read_customer stand in for orders:read', () => {
    expect(hasAccess(keyCtx(['orders:read_customer']), ACCESS.orders)).toBe(
      false,
    );
  });
});

describe('row visibility', () => {
  it('limits a key to the orders it placed itself', () => {
    expect(orderVisibility(keyCtx(['orders:read']))).toEqual({
      integrationKeyId: 'k1',
    });
  });

  it('lets staff see every order of their restaurant', () => {
    expect(orderVisibility(staffCtx(['orders.create']))).toEqual({});
  });

  it('shows a key only what the website menu shows', () => {
    expect(menuVisibility(keyCtx(['menu:read']))).toEqual({
      category: { isActive: true, showOnWebsite: true },
      item: { isActive: true },
    });
  });

  it('shows staff the whole menu, including hidden items', () => {
    expect(menuVisibility(staffCtx(['menu.view']))).toEqual({
      category: {},
      item: {},
    });
  });
});
