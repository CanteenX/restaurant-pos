import type { Customer } from '@prisma/client';
import { customerSearchWhere } from '../../modules/customers/customers.service';
import { ACCESS } from '../graphql-access';
import { requireAccess } from '../graphql-context';
import { clampPage, type PageLimits } from '../graphql-limits';
import {
  keysetOrderBy,
  keysetWhere,
  toConnection,
  type SortKey,
} from '../graphql-pagination';
import { iso, type PageArgs, type RequestScope } from '../graphql-scope';

// Keep defaultSize equal to the SDL argument default (cost rule).
export const CUSTOMER_PAGE: PageLimits = { defaultSize: 20, max: 100 };
const SORT: SortKey = { field: 'createdAt', dir: 'desc', kind: 'date' };

type CustomersArgs = PageArgs & {
  branchId?: string | null;
  search?: string | null;
};

// Explicit allow-list: never the raw row (allergies, notes, wallet, birthday).
const present = (c: Customer) => ({
  id: c.id,
  branchId: c.branchId,
  name: c.name,
  phone: c.phone,
  email: c.email,
  loyaltyPoints: c.loyaltyPoints,
  createdAt: iso(c.createdAt),
});

export function customerResolvers(s: RequestScope) {
  return {
    customers: async (args: CustomersArgs) => {
      requireAccess(s.ctx, ACCESS.customers);
      const size = clampPage(args.first, CUSTOMER_PAGE);
      const rows = await s.prisma.customer.findMany({
        where: {
          AND: [
            await s.branchWhere(args.branchId),
            customerSearchWhere(args.search?.trim()),
            keysetWhere(SORT, args.after),
          ],
        },
        orderBy: keysetOrderBy(SORT),
        take: size + 1,
      });
      return toConnection(SORT, rows, size, present);
    },

    customer: async ({ id }: { id: string }) => {
      requireAccess(s.ctx, ACCESS.customers);
      const row = await s.prisma.customer.findFirst({
        where: { AND: [{ id }, await s.branchWhere(null)] },
      });
      return row ? present(row) : null;
    },
  };
}
