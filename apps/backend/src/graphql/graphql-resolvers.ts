import { scopedBranchId, type GraphqlContext } from './graphql-context';
import { customerResolvers } from './resolvers/customers.resolvers';
import { menuResolvers } from './resolvers/menu.resolvers';
import { orderResolvers } from './resolvers/orders.resolvers';
import type { BranchWhere, RequestScope, ResolverDeps } from './graphql-scope';

/**
 * Root resolvers for ONE request. Loaders and memoised lookups live in this
 * closure, so nothing cached is ever shared between requests or tenants.
 */
export function createRootValue(deps: ResolverDeps, ctx: GraphqlContext) {
  const scope: RequestScope = {
    ...deps,
    ctx,
    branchWhere: (requested) => branchWhere(deps, ctx, requested),
  };
  return {
    viewer: () => viewer(ctx),
    ...menuResolvers(scope),
    ...orderResolvers(scope),
    ...customerResolvers(scope),
  };
}

// Always filters by the credential's restaurant; a requested branch must be
// one of its branches (BranchAccessService, as REST) and a location-locked
// key is pinned to its own branch (scopedBranchId).
async function branchWhere(
  deps: ResolverDeps,
  ctx: GraphqlContext,
  requested: string | null | undefined,
): Promise<BranchWhere> {
  const tenant = { restaurantId: ctx.restaurantId };
  const branchId = scopedBranchId(ctx, requested);
  if (!branchId) return { branch: tenant };
  await deps.branchAccess.assertAccess(ctx.restaurantId, branchId);
  return { branch: tenant, branchId };
}

function viewer(ctx: GraphqlContext) {
  const p = ctx.principal;
  return {
    kind: p.kind === 'integration' ? 'INTEGRATION_KEY' : 'STAFF',
    id: p.id,
    restaurantId: ctx.restaurantId,
    branchId: ctx.branchId,
    grants: p.kind === 'integration' ? p.scopes : p.permissions,
  };
}
