import type { MenuCategory, MenuItem } from '@prisma/client';
import {
  adjustOnlinePrice,
  onlinePriceAdjustOf,
  type OnlinePriceAdjust,
} from '../../common/online-price';
import { ACCESS, menuVisibility } from '../graphql-access';
import { requireAccess } from '../graphql-context';
import { clampPage, type PageLimits } from '../graphql-limits';
import { BatchLoader } from '../graphql-loader';
import {
  keysetOrderBy,
  keysetWhere,
  toConnection,
  type SortKey,
} from '../graphql-pagination';
import { num, type PageArgs, type RequestScope } from '../graphql-scope';

// Keep defaultSize equal to the SDL argument default (cost rule).
export const MENU_PAGE: PageLimits = { defaultSize: 50, max: 200 };
const SORT: SortKey = { field: 'sortOrder', dir: 'asc', kind: 'number' };

type CategoryArgs = PageArgs & { branchId?: string | null };
type ItemArgs = CategoryArgs & { categoryId?: string | null };

export function menuResolvers(s: RequestScope) {
  const visible = menuVisibility(s.ctx);
  const categories = new BatchLoader<string, MenuCategory>(async (ids) => {
    const rows = await s.prisma.menuCategory.findMany({
      where: {
        id: { in: [...ids] },
        branch: { restaurantId: s.ctx.restaurantId },
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  });

  // Keys are quoted the website price (Settings online price change applied),
  // exactly as the REST menu; staff get the menu price.
  let adjust: Promise<OnlinePriceAdjust | null> | undefined;
  const onlineAdjust = () =>
    (adjust ??= s.prisma.restaurant
      .findUniqueOrThrow({
        where: { id: s.ctx.restaurantId },
        select: { onlinePriceAdjustKind: true, onlinePriceAdjustValue: true },
      })
      .then(onlinePriceAdjustOf));

  const presentCategory = (c: MenuCategory) => ({
    id: c.id,
    branchId: c.branchId,
    name: c.name,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    showOnWebsite: c.showOnWebsite,
  });

  const presentItem = (i: MenuItem, adj: OnlinePriceAdjust | null) => ({
    id: i.id,
    branchId: i.branchId,
    categoryId: i.categoryId,
    name: i.name,
    description: i.description,
    imageUrl: i.imageUrl,
    price: adjustOnlinePrice(Number(i.price), adj),
    taxRatePercent: Number(i.taxRatePercent),
    isVeg: i.isVeg,
    isVegan: i.isVegan,
    spiceLevel: i.spiceLevel,
    allergens: i.allergens,
    availableFrom: i.availableFrom,
    availableTo: i.availableTo,
    isActive: i.isActive,
    category: async () => {
      const c = await categories.load(i.categoryId);
      return c ? presentCategory(c) : null;
    },
    costPrice: () => {
      requireAccess(s.ctx, ACCESS.menuCost);
      return num(i.costPrice);
    },
  });

  return {
    menuCategories: async (args: CategoryArgs) => {
      requireAccess(s.ctx, ACCESS.menu);
      const size = clampPage(args.first, MENU_PAGE);
      const rows = await s.prisma.menuCategory.findMany({
        where: {
          AND: [
            await s.branchWhere(args.branchId),
            visible.category,
            keysetWhere(SORT, args.after),
          ],
        },
        orderBy: keysetOrderBy(SORT),
        take: size + 1,
      });
      return toConnection(SORT, rows, size, presentCategory);
    },

    menuItems: async (args: ItemArgs) => {
      requireAccess(s.ctx, ACCESS.menu);
      const size = clampPage(args.first, MENU_PAGE);
      const rows = await s.prisma.menuItem.findMany({
        where: {
          AND: [
            await s.branchWhere(args.branchId),
            visible.item,
            { category: visible.category },
            args.categoryId ? { categoryId: args.categoryId } : {},
            keysetWhere(SORT, args.after),
          ],
        },
        orderBy: keysetOrderBy(SORT),
        take: size + 1,
      });
      const isKey = s.ctx.principal.kind === 'integration';
      const adj = isKey ? await onlineAdjust() : null;
      return toConnection(SORT, rows, size, (i) => presentItem(i, adj));
    },
  };
}
