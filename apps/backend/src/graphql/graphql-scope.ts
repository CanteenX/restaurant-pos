import type { Prisma } from '@prisma/client';
import type { BranchAccessService } from '../common/services/branch-access.service';
import type { IntegrationsService } from '../integrations/integrations.service';
import type { MenuService } from '../modules/menu/menu.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GraphqlContext } from './graphql-context';

export type ResolverDeps = Readonly<{
  prisma: PrismaService;
  branchAccess: BranchAccessService;
  integrations: IntegrationsService;
  menu: MenuService;
}>;

/** What every resolver factory gets: services plus the request's tenant. */
export type RequestScope = ResolverDeps &
  Readonly<{
    ctx: GraphqlContext;
    /** Tenant filter for a branch-owned row (menu, order, customer). */
    branchWhere(requested?: string | null): Promise<BranchWhere>;
  }>;

export type BranchWhere = {
  branch: Prisma.BranchWhereInput;
  branchId?: string;
};

export type PageArgs = { first?: number | null; after?: string | null };

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const num = (d: Prisma.Decimal | null | undefined) =>
  d == null ? null : Number(d);
