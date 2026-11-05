import { Prisma } from '@prisma/client';
import { GraphQLObjectType, type GraphQLField } from 'graphql';
import type { BranchAccessService } from '../common/services/branch-access.service';
import type { IntegrationsService } from '../integrations/integrations.service';
import type { MenuService } from '../modules/menu/menu.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GraphqlContext } from './graphql-context';
import { GraphqlService } from './graphql.service';
import { schema } from './graphql.schema';
import { CUSTOMER_PAGE } from './resolvers/customers.resolvers';
import { MENU_PAGE } from './resolvers/menu.resolvers';
import {
  MODIFIER_PAGE,
  ORDER_ITEM_PAGE,
  ORDER_PAGE,
} from './resolvers/orders.resolvers';

const staff: GraphqlContext = {
  restaurantId: 'r1',
  branchId: null,
  principal: {
    kind: 'staff',
    id: 'u1',
    permissions: ['orders.create', 'customers.manage'],
  },
};

const order = (n: number) => ({
  id: `o${n}`,
  branchId: 'b1',
  orderNumber: `${n}`,
  type: 'TAKEAWAY',
  status: 'OPEN',
  channel: 'STAFF',
  acceptance: 'NOT_REQUIRED',
  createdAt: new Date(2026, 0, n),
  scheduledFor: null,
  notes: null,
  customerId: `c${n}`,
  guestName: null,
  subtotal: new Prisma.Decimal(100),
  taxAmount: new Prisma.Decimal(5),
  discountAmount: new Prisma.Decimal(0),
  loyaltyDiscountAmount: new Prisma.Decimal(0),
  deliveryFee: new Prisma.Decimal(0),
});

function setup() {
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue([1, 2, 3].map(order)) },
    orderItem: {
      findMany: jest.fn(({ where }: { where: { orderId: { in: string[] } } }) =>
        Promise.resolve(
          where.orderId.in.map((orderId) => ({
            id: `i-${orderId}`,
            orderId,
            nameSnapshot: 'Tea',
            unitPriceSnapshot: new Prisma.Decimal(10),
            lineTotal: new Prisma.Decimal(10),
            quantity: 1,
            kitchenNote: null,
            modifiers: [],
          })),
        ),
      ),
    },
    customer: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({ id, name: id, phone: null, email: null })),
        ),
      ),
    },
  };
  const branchAccess = { assertAccess: jest.fn() };
  const service = new GraphqlService(
    prisma as unknown as PrismaService,
    branchAccess as unknown as BranchAccessService,
    {} as IntegrationsService,
    {} as MenuService,
  );
  return { prisma, service };
}

describe('GraphQL read resolvers', () => {
  it('loads order items and customers with one query each (no N+1)', async () => {
    const { prisma, service } = setup();
    const res = await service.run(
      {
        query: '{ orders { nodes { id items { name } customer { name } } } }',
      },
      staff,
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({
      orders: {
        nodes: [1, 2, 3].map((n) => ({
          id: `o${n}`,
          items: [{ name: 'Tea' }],
          customer: { name: `c${n}` },
        })),
      },
    });
    expect(prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
  });

  it('always filters orders by the credential restaurant', async () => {
    const { prisma, service } = setup();
    await service.run({ query: '{ orders { nodes { id } } }' }, staff);
    const [[call]] = prisma.order.findMany.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(call.where.AND).toContainEqual({ branch: { restaurantId: 'r1' } });
  });

  it('keeps every SDL page default equal to its resolver default', () => {
    const arg = (type: string, field: string) => {
      const t = schema.getType(type) as GraphQLObjectType;
      const f: GraphQLField<unknown, unknown> = t.getFields()[field];
      return f.args.find((a) => a.name === 'first')?.defaultValue;
    };
    expect(arg('Query', 'menuCategories')).toBe(MENU_PAGE.defaultSize);
    expect(arg('Query', 'menuItems')).toBe(MENU_PAGE.defaultSize);
    expect(arg('Query', 'orders')).toBe(ORDER_PAGE.defaultSize);
    expect(arg('Query', 'customers')).toBe(CUSTOMER_PAGE.defaultSize);
    expect(arg('Order', 'items')).toBe(ORDER_ITEM_PAGE.defaultSize);
    expect(arg('OrderItem', 'modifiers')).toBe(MODIFIER_PAGE.defaultSize);
  });

  it('fits the default orders query inside the default cost budget', async () => {
    const { service } = setup();
    const res = await service.run(
      {
        query:
          '{ orders { nodes { id orderNumber status totals { total } items { name quantity modifiers { name } } customer { name } } pageInfo { endCursor } } }',
      },
      staff,
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.status).toBe(200);
  });
});
