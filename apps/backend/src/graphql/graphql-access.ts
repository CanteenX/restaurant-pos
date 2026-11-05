import type { IntegrationScope, PermissionKey } from '@nventra/types';
import { permissionSatisfied } from '@nventra/types';
import type { GraphqlContext } from './graphql-context';

export type AccessRule = Readonly<{
  scope?: IntegrationScope;
  permission?: PermissionKey;
}>;

// One rule per gated part of the schema. An integration key needs `scope`, a
// staff session `permission` (the same key its REST route uses). A rule with
// no `scope` is staff-only: no key can ever hold it.
export const ACCESS = {
  menu: { scope: 'menu:read', permission: 'menu.view' },
  // Cost price is internal margin data: staff who manage the menu only.
  menuCost: { permission: 'menu.manage' },
  orders: { scope: 'orders:read', permission: 'orders.create' },
  // Customer name/phone/email on an order (PII), on top of `orders`.
  orderCustomer: {
    scope: 'orders:read_customer',
    permission: 'customers.manage',
  },
  customers: { scope: 'customers:read', permission: 'customers.manage' },
} as const satisfies Record<string, AccessRule>;

export function hasAccess(ctx: GraphqlContext, rule: AccessRule): boolean {
  const p = ctx.principal;
  return p.kind === 'integration'
    ? !!rule.scope && p.scopes.includes(rule.scope)
    : !!rule.permission && permissionSatisfied(p.permissions, rule.permission);
}

/** Extra order filter: a key only ever sees the orders it placed (as REST). */
export function orderVisibility(ctx: GraphqlContext): {
  integrationKeyId?: string;
} {
  return ctx.principal.kind === 'integration'
    ? { integrationKeyId: ctx.principal.id }
    : {};
}

/**
 * A key sees what the website menu shows (active, shown-on-website
 * categories; active items), exactly as the REST menu. Staff see it all.
 */
export function menuVisibility(ctx: GraphqlContext): {
  category: { isActive?: true; showOnWebsite?: true };
  item: { isActive?: true };
} {
  return ctx.principal.kind === 'integration'
    ? {
        category: { isActive: true, showOnWebsite: true },
        item: { isActive: true },
      }
    : { category: {}, item: {} };
}
