import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { graphqlCreateOrderArgsSchema } from '@nventra/types';
import type { Customer, Order, OrderStatus, Prisma } from '@prisma/client';
import { orderTotals } from '../../integrations/integrations.service';
import { ACCESS, orderVisibility } from '../graphql-access';
import { requireAccess, scopedBranchId } from '../graphql-context';
import { parseArgs } from '../graphql-input';
import { clampPage, type PageLimits } from '../graphql-limits';
import { BatchLoader } from '../graphql-loader';
import {
  keysetOrderBy,
  keysetWhere,
  toConnection,
  type SortKey,
} from '../graphql-pagination';
import { iso, type PageArgs, type RequestScope } from '../graphql-scope';

// Keep defaultSize equal to the SDL argument default (cost rule).
export const ORDER_PAGE: PageLimits = { defaultSize: 10, max: 100 };
export const ORDER_ITEM_PAGE: PageLimits = { defaultSize: 10, max: 100 };
export const MODIFIER_PAGE: PageLimits = { defaultSize: 5, max: 50 };
const SORT: SortKey = { field: 'createdAt', dir: 'desc', kind: 'date' };

const ITEM_INCLUDE = {
  modifiers: { orderBy: { id: 'asc' } },
} satisfies Prisma.OrderItemInclude;
type ItemRow = Prisma.OrderItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

type OrdersArgs = PageArgs & {
  branchId?: string | null;
  status?: OrderStatus | null;
};

export function orderResolvers(s: RequestScope) {
  // Items and customers are only reached through an order the caller may
  // already see, so the loaders key on that order's own ids.
  const items = new BatchLoader<string, ItemRow[]>(async (orderIds) => {
    const rows = await s.prisma.orderItem.findMany({
      where: { orderId: { in: [...orderIds] } },
      include: ITEM_INCLUDE,
      orderBy: { id: 'asc' },
    });
    const byOrder = new Map<string, ItemRow[]>();
    for (const r of rows) {
      byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
    }
    return byOrder;
  });
  const customers = new BatchLoader<string, Customer>(async (ids) => {
    const rows = await s.prisma.customer.findMany({
      where: {
        id: { in: [...ids] },
        branch: { restaurantId: s.ctx.restaurantId },
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  });

  const presentItem = (i: ItemRow) => ({
    id: i.id,
    name: i.nameSnapshot,
    quantity: i.quantity,
    unitPrice: Number(i.unitPriceSnapshot),
    lineTotal: Number(i.lineTotal),
    kitchenNote: i.kitchenNote,
    modifiers: ({ first }: { first?: number | null }) =>
      i.modifiers.slice(0, clampPage(first, MODIFIER_PAGE)).map((m) => ({
        name: m.nameSnapshot,
        priceAdjustment: Number(m.priceAdjSnapshot),
      })),
  });

  const presentOrder = (o: Order) => ({
    id: o.id,
    branchId: o.branchId,
    orderNumber: o.orderNumber,
    type: o.type,
    status: o.status,
    channel: o.channel,
    acceptance: o.acceptance,
    createdAt: iso(o.createdAt),
    scheduledFor: iso(o.scheduledFor),
    notes: o.notes,
    totals: orderTotals(o),
    items: async ({ first }: { first?: number | null }) => {
      const rows = (await items.load(o.id)) ?? [];
      return rows.slice(0, clampPage(first, ORDER_ITEM_PAGE)).map(presentItem);
    },
    // Personal data: its own grant on top of order access. Without it the
    // field is null with a FORBIDDEN error; the rest of the order still loads.
    customer: async () => {
      requireAccess(s.ctx, ACCESS.orderCustomer);
      const c = o.customerId ? await customers.load(o.customerId) : undefined;
      if (!c && !o.guestName) return null;
      return {
        name: o.guestName ?? c?.name ?? null,
        phone: c?.phone ?? null,
        email: c?.email ?? null,
      };
    },
  });

  return {
    orders: async (args: OrdersArgs) => {
      requireAccess(s.ctx, ACCESS.orders);
      const size = clampPage(args.first, ORDER_PAGE);
      const rows = await s.prisma.order.findMany({
        where: {
          AND: [
            await s.branchWhere(args.branchId),
            orderVisibility(s.ctx),
            args.status ? { status: args.status } : {},
            keysetWhere(SORT, args.after),
          ],
        },
        orderBy: keysetOrderBy(SORT),
        take: size + 1,
      });
      return toConnection(SORT, rows, size, presentOrder);
    },

    order: async ({ id }: { id: string }) => {
      requireAccess(s.ctx, ACCESS.orders);
      // null both when it does not exist and when it is not the caller's.
      const row = await s.prisma.order.findFirst({
        where: {
          AND: [{ id }, await s.branchWhere(null), orderVisibility(s.ctx)],
        },
      });
      return row ? presentOrder(row) : null;
    },

    // Mutation (#79). The REST order path does the rest: tenant/branch check,
    // server pricing, minimum order, website price, idempotent replay.
    createOrder: async (raw: unknown) => {
      requireAccess(s.ctx, ACCESS.orderWrite);
      const p = s.ctx.principal;
      // ACCESS.orderWrite has no staff permission; this narrows the type.
      if (p.kind !== 'integration') throw new ForbiddenException();
      const args = parseArgs(graphqlCreateOrderArgsSchema, raw);
      const branchId = scopedBranchId(s.ctx, args.branchId)!;
      const created = await s.integrations.createOrder(
        {
          id: p.id,
          restaurantId: s.ctx.restaurantId,
          branchId: s.ctx.branchId,
          scopes: [...p.scopes],
        },
        branchId,
        args.input,
        args.idempotencyKey,
      );
      const row = await s.prisma.order.findFirst({
        where: {
          AND: [
            { id: created.id },
            orderVisibility(s.ctx),
            { branch: { restaurantId: s.ctx.restaurantId } },
          ],
        },
      });
      if (!row) throw new NotFoundException('Order not found');
      return presentOrder(row);
    },
  };
}
