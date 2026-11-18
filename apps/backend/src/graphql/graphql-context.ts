import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  type IntegrationScope,
  type PermissionKey,
  type SessionUser,
} from '@nventra/types';
import { hasAccess } from './graphql-access';

type IntegrationKeyPrincipal = {
  id: string;
  restaurantId: string;
  branchId: string | null;
  scopes: string[];
};

export type GraphqlPrincipal =
  | { kind: 'integration'; id: string; scopes: readonly string[] }
  | { kind: 'staff'; id: string; permissions: readonly string[] };

// The per-request tenant. Built ONLY from the authenticated credential —
// never from headers, variables or arguments — and frozen, so a resolver
// cannot retarget another restaurant even by accident. Every resolver must
// filter by ctx.restaurantId and pass branch arguments through
// scopedBranchId(). Staff sessions carry branchId null: resolvers check a
// staff member's branch access with BranchAccessService, as REST does.
export type GraphqlContext = Readonly<{
  restaurantId: string;
  branchId: string | null;
  principal: Readonly<GraphqlPrincipal>;
}>;

export function buildGraphqlContext(req: {
  integrationKey?: IntegrationKeyPrincipal;
  user?: SessionUser;
}): GraphqlContext {
  const key = req.integrationKey;
  if (key) {
    return freeze(key.restaurantId, key.branchId, {
      kind: 'integration',
      id: key.id,
      scopes: Object.freeze([...key.scopes]),
    });
  }
  const user = req.user;
  if (user) {
    return freeze(user.restaurantId, null, {
      kind: 'staff',
      id: user.id,
      permissions: Object.freeze([...user.permissions]),
    });
  }
  throw new UnauthorizedException('Authentication required');
}

function freeze(
  restaurantId: string,
  branchId: string | null,
  principal: GraphqlPrincipal,
): GraphqlContext {
  if (!restaurantId) {
    throw new UnauthorizedException('Credential has no restaurant');
  }
  return Object.freeze({
    restaurantId,
    branchId,
    principal: Object.freeze(principal),
  });
}

/**
 * The branch a resolver may read. A branch-locked integration key always
 * resolves to its own branch and is refused any other; an unlocked principal
 * gets what it asked for (or null = all branches of its restaurant).
 */
export function scopedBranchId(
  ctx: GraphqlContext,
  requested: string | null | undefined,
): string | null {
  if (ctx.branchId) {
    if (requested && requested !== ctx.branchId) {
      throw new ForbiddenException(
        'This API key is locked to another location',
      );
    }
    return ctx.branchId;
  }
  return requested ?? null;
}

/**
 * Gate for a resolver. An integration key needs `scope`, a staff session
 * needs `permission`; a principal kind with no rule is denied, so a resolver
 * meant only for keys is never silently open to sessions (or vice versa).
 */
export function requireAccess(
  ctx: GraphqlContext,
  rule: { scope?: IntegrationScope; permission?: PermissionKey },
): void {
  const p = ctx.principal;
  const ok = hasAccess(ctx, rule);
  if (!ok) {
    throw new ForbiddenException(
      p.kind === 'integration'
        ? `This API key is missing required scope: ${rule.scope ?? '(none allowed)'}`
        : 'You do not have permission for this field',
    );
  }
}
