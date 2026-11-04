import { buildSchema } from 'graphql';
import type { GraphqlContext } from './graphql-context';

// Schema-first (SDL + root resolvers on plain graphql-js), see
// docs/graphql-api.md for why. Resolvers for menu/orders/customers are added
// by the follow-up issues; each must call requireAccess() and filter by
// ctx.restaurantId / scopedBranchId(ctx, …). Every list field needs a page
// argument (first/last/limit/take) that the resolver runs through
// clampPage() (null/omitted = default page, capped at a server maximum): the
// cost rule charges a list without one as a single item.
export const typeDefs = /* GraphQL */ `
  enum PrincipalKind {
    INTEGRATION_KEY
    STAFF
  }

  "Who is calling, and which tenant every field in this request is scoped to."
  type Viewer {
    kind: PrincipalKind!
    id: ID!
    restaurantId: ID!
    "Set when an integration key is locked to one location."
    branchId: ID
    "Integration key scopes, or the staff member's permissions."
    grants: [String!]!
  }

  type Query {
    viewer: Viewer!
  }
`;

export const schema = buildSchema(typeDefs);

export const rootValue = {
  viewer: (_args: unknown, ctx: GraphqlContext) => {
    const p = ctx.principal;
    return {
      kind: p.kind === 'integration' ? 'INTEGRATION_KEY' : 'STAFF',
      id: p.id,
      restaurantId: ctx.restaurantId,
      branchId: ctx.branchId,
      grants: p.kind === 'integration' ? p.scopes : p.permissions,
    };
  },
};
