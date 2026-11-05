import {
  graphqlCreateOrderArgsSchema,
  graphqlSetMenuItemAvailabilityArgsSchema,
} from '@nventra/types';
import { Prisma } from '@prisma/client';
import type { BranchAccessService } from '../common/services/branch-access.service';
import type { IntegrationsService } from '../integrations/integrations.service';
import type { MenuService } from '../modules/menu/menu.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GraphqlContext } from './graphql-context';
import { GraphqlService } from './graphql.service';

const key = (scopes: string[], branchId: string | null = null) =>
  ({
    restaurantId: 'r1',
    branchId,
    principal: { kind: 'integration', id: 'k1', scopes },
  }) as GraphqlContext;
const staff = (permissions: string[]): GraphqlContext => ({
  restaurantId: 'r1',
  branchId: null,
  principal: { kind: 'staff', id: 'u1', permissions },
});

const ORDER_INPUT = {
  customerName: 'Asha',
  customerPhone: '+91 98765 43210',
  items: [{ menuItemId: 'm1', quantity: 2 }],
};
const CREATE = `mutation($input: CreateOrderInput!, $key: String) {
  createOrder(branchId: "b1", input: $input, idempotencyKey: $key) {
    id orderNumber status channel totals { total }
  }
}`;
const TOGGLE = `mutation($available: Boolean!) {
  setMenuItemAvailability(id: "m1", available: $available) { id isActive price }
}`;

const orderRow = {
  id: 'o1',
  branchId: 'b1',
  orderNumber: 'A-1',
  type: 'TAKEAWAY',
  status: 'OPEN',
  channel: 'ONLINE',
  acceptance: 'PENDING',
  createdAt: new Date(2026, 0, 1),
  scheduledFor: null,
  notes: null,
  customerId: null,
  guestName: 'Asha',
  subtotal: new Prisma.Decimal(200),
  taxAmount: new Prisma.Decimal(9.52),
  discountAmount: new Prisma.Decimal(0),
  loyaltyDiscountAmount: new Prisma.Decimal(0),
  tipAmount: new Prisma.Decimal(0),
  deliveryFee: new Prisma.Decimal(0),
};
const itemRow = (isActive: boolean) => ({
  id: 'm1',
  branchId: 'b1',
  categoryId: 'c1',
  name: 'Tea',
  description: null,
  imageUrl: null,
  price: new Prisma.Decimal(100),
  taxRatePercent: new Prisma.Decimal(5),
  isVeg: true,
  isVegan: false,
  spiceLevel: 'NONE',
  allergens: [],
  availableFrom: null,
  availableTo: null,
  isActive,
  costPrice: new Prisma.Decimal(40),
});

function setup() {
  const prisma = {
    order: { findFirst: jest.fn().mockResolvedValue(orderRow) },
    menuItem: { findFirst: jest.fn().mockResolvedValue(itemRow(true)) },
    restaurant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        onlinePriceAdjustKind: 'NONE',
        onlinePriceAdjustValue: new Prisma.Decimal(0),
      }),
    },
  };
  const branchAccess = { assertAccess: jest.fn() };
  const integrations = {
    createOrder: jest.fn().mockResolvedValue({ id: 'o1' }),
  };
  const menu = {
    updateItem: jest.fn().mockResolvedValue(itemRow(false)),
  };
  const service = new GraphqlService(
    prisma as unknown as PrismaService,
    branchAccess as unknown as BranchAccessService,
    integrations as unknown as IntegrationsService,
    menu as unknown as MenuService,
  );
  return { prisma, integrations, menu, service };
}

const codes = (body: { errors?: readonly { extensions?: unknown }[] }) =>
  (body.errors ?? []).map(
    (e) => (e.extensions as { code?: string } | undefined)?.code,
  );

describe('GraphQL mutation input schemas (shared zod)', () => {
  it('accepts a minimal takeaway order and defaults the type', () => {
    const r = graphqlCreateOrderArgsSchema.parse({
      branchId: 'b1',
      input: ORDER_INPUT,
    });
    expect(r.input.type).toBe('TAKEAWAY');
    expect(r.input.items[0].modifierIds).toEqual([]);
  });

  it('rejects a malformed idempotency key', () => {
    const r = graphqlCreateOrderArgsSchema.safeParse({
      branchId: 'b1',
      idempotencyKey: 'short',
      input: ORDER_INPUT,
    });
    expect(r.success).toBe(false);
  });

  it('requires delivery details for a DELIVERY order', () => {
    const r = graphqlCreateOrderArgsSchema.safeParse({
      branchId: 'b1',
      input: { ...ORDER_INPUT, type: 'DELIVERY' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty basket and a bad phone number', () => {
    for (const input of [
      { ...ORDER_INPUT, items: [] },
      { ...ORDER_INPUT, customerPhone: 'call me' },
    ]) {
      expect(
        graphqlCreateOrderArgsSchema.safeParse({ branchId: 'b1', input })
          .success,
      ).toBe(false);
    }
  });

  it('requires an item id and a boolean for availability', () => {
    expect(
      graphqlSetMenuItemAvailabilityArgsSchema.safeParse({
        id: ' ',
        available: true,
      }).success,
    ).toBe(false);
    expect(
      graphqlSetMenuItemAvailabilityArgsSchema.safeParse({
        id: 'm1',
        available: false,
      }).success,
    ).toBe(true);
  });
});

describe('GraphQL createOrder', () => {
  it('creates through IntegrationsService with the key and idempotency key', async () => {
    const { service, integrations, prisma } = setup();
    const res = await service.run(
      {
        query: CREATE,
        variables: { input: ORDER_INPUT, key: 'retry-abc-123' },
      },
      key(['orders:write']),
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({
      createOrder: {
        id: 'o1',
        orderNumber: 'A-1',
        status: 'OPEN',
        channel: 'ONLINE',
        totals: { total: 200 },
      },
    });
    expect(integrations.createOrder).toHaveBeenCalledWith(
      {
        id: 'k1',
        restaurantId: 'r1',
        branchId: null,
        scopes: ['orders:write'],
      },
      'b1',
      expect.objectContaining({
        type: 'TAKEAWAY',
        customerName: 'Asha',
        items: [{ menuItemId: 'm1', quantity: 2, modifierIds: [] }],
      }),
      'retry-abc-123',
    );
    // The response is re-read as the key's own order, in its own tenant.
    const [[lookup]] = prisma.order.findFirst.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(lookup.where.AND).toEqual(
      expect.arrayContaining([
        { id: 'o1' },
        { integrationKeyId: 'k1' },
        { branch: { restaurantId: 'r1' } },
      ]),
    );
  });

  it('drops explicit nulls GraphQL sends for omitted optionals', async () => {
    const { service, integrations } = setup();
    const res = await service.run(
      {
        query: CREATE,
        variables: {
          input: { ...ORDER_INPUT, notes: null, customerEmail: null },
          key: null,
        },
      },
      key(['orders:write']),
    );
    expect(res.body.errors).toBeUndefined();
    const [[, , dto, idem]] = integrations.createOrder.mock.calls as [
      [unknown, string, Record<string, unknown>, unknown],
    ];
    expect(dto).not.toHaveProperty('notes');
    expect(dto).not.toHaveProperty('customerEmail');
    expect(idem).toBeUndefined();
  });

  it('maps invalid input to BAD_USER_INPUT without creating anything', async () => {
    const { service, integrations } = setup();
    const res = await service.run(
      {
        query: CREATE,
        variables: { input: { ...ORDER_INPUT, items: [] }, key: 'nope' },
      },
      key(['orders:write']),
    );
    expect(res.body.data).toBeNull();
    expect(codes(res.body)).toEqual(['BAD_USER_INPUT']);
    expect(integrations.createOrder).not.toHaveBeenCalled();
  });

  it('refuses a key without orders:write and every staff session', async () => {
    for (const ctx of [
      key(['orders:read', 'menu:read']),
      staff(['orders.create', 'menu.manage']),
    ]) {
      const { service, integrations } = setup();
      const res = await service.run(
        { query: CREATE, variables: { input: ORDER_INPUT } },
        ctx,
      );
      expect(codes(res.body)).toEqual(['FORBIDDEN']);
      expect(integrations.createOrder).not.toHaveBeenCalled();
    }
  });

  it('refuses a location-locked key ordering for another location', async () => {
    const { service, integrations } = setup();
    const res = await service.run(
      { query: CREATE, variables: { input: ORDER_INPUT } },
      key(['orders:write'], 'b2'),
    );
    expect(codes(res.body)).toEqual(['FORBIDDEN']);
    expect(integrations.createOrder).not.toHaveBeenCalled();
  });

  it('allows only one mutation field per request', async () => {
    const { service, integrations } = setup();
    const res = await service.run(
      {
        query: `mutation($input: CreateOrderInput!) {
          a: createOrder(branchId: "b1", input: $input) { id }
          ... on Mutation { b: createOrder(branchId: "b1", input: $input) { id } }
        }`,
        variables: { input: ORDER_INPUT },
      },
      key(['orders:write']),
    );
    expect(res.status).toBe(400);
    expect(res.body.errors?.[0].message).toMatch(/one mutation field/i);
    expect(integrations.createOrder).not.toHaveBeenCalled();
  });
});

describe('GraphQL setMenuItemAvailability', () => {
  it('lets a key with menu:availability mark an item sold out', async () => {
    const { service, menu, prisma } = setup();
    const res = await service.run(
      { query: TOGGLE, variables: { available: false } },
      key(['menu:availability']),
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({
      setMenuItemAvailability: { id: 'm1', isActive: false, price: 100 },
    });
    expect(menu.updateItem).toHaveBeenCalledWith(
      'b1',
      'm1',
      null,
      { isActive: false },
      { integrationKeyId: 'k1' },
    );
    const [[lookup]] = prisma.menuItem.findFirst.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(lookup.where.AND).toContainEqual({
      branch: { restaurantId: 'r1' },
    });
  });

  it('pins a location-locked key to its own branch', async () => {
    const { service, prisma } = setup();
    await service.run(
      { query: TOGGLE, variables: { available: true } },
      key(['menu:availability'], 'b1'),
    );
    const [[lookup]] = prisma.menuItem.findFirst.mock.calls as [
      [{ where: { AND: unknown[] } }],
    ];
    expect(lookup.where.AND).toContainEqual({
      branch: { restaurantId: 'r1' },
      branchId: 'b1',
    });
  });

  it('records the staff member when staff with menu.manage toggle it', async () => {
    const { service, menu } = setup();
    const res = await service.run(
      { query: TOGGLE, variables: { available: false } },
      staff(['menu.manage']),
    );
    expect(res.body.errors).toBeUndefined();
    expect(menu.updateItem).toHaveBeenCalledWith(
      'b1',
      'm1',
      'u1',
      { isActive: false },
      undefined,
    );
  });

  it('refuses menu:read keys and menu.view staff', async () => {
    for (const ctx of [key(['menu:read']), staff(['menu.view'])]) {
      const { service, menu } = setup();
      const res = await service.run(
        { query: TOGGLE, variables: { available: false } },
        ctx,
      );
      expect(codes(res.body)).toEqual(['FORBIDDEN']);
      expect(menu.updateItem).not.toHaveBeenCalled();
    }
  });

  it('is NOT_FOUND for an item outside the tenant', async () => {
    const { service, menu, prisma } = setup();
    prisma.menuItem.findFirst.mockResolvedValue(null);
    const res = await service.run(
      { query: TOGGLE, variables: { available: false } },
      key(['menu:availability']),
    );
    expect(codes(res.body)).toEqual(['NOT_FOUND']);
    expect(menu.updateItem).not.toHaveBeenCalled();
  });
});
