// Aggregator menu and availability sync (#59): payload building, dedupe keys
// and the partner calls against the in-process mock partner.
import { AggregatorMock } from '../../test/mocks/aggregator-mock';
import {
  availabilityKeyPrefix,
  buildMenu,
  externalItemId,
  menuPushKeyPrefix,
  outletsForBranch,
  queuedKey,
  toPlatformAvailability,
  touchesMenu,
} from './aggregator-menu';
import { PartnerApiProvider } from './providers/partner-api.provider';

const API_KEY = 'key_menu_test';
const SECRET = 'whsec_menu_0123456789abcdef';
const NET = { allowPrivate: true, allowInsecure: true };

describe('item ids and dedupe keys', () => {
  it('uses the mapped platform id, else our own', () => {
    expect(externalItemId({ a: 'zom-1' }, 'a')).toBe('zom-1');
    expect(externalItemId({ a: 'zom-1' }, 'b')).toBe('b');
    expect(externalItemId(undefined, 'b')).toBe('b');
  });

  it('gives every queued call a fresh key under a per-item / per-branch prefix', () => {
    // Coalescing happens only against a still-pending row (outbox service);
    // a delivered row must never swallow a later edit (review #200 items 1-2).
    const a = availabilityKeyPrefix('item1');
    expect(a).toBe('item.availability:item1:');
    expect(menuPushKeyPrefix('br1')).toBe('menu.push:br1:');
    const k1 = queuedKey(a);
    const k2 = queuedKey(a);
    expect(k1.startsWith(a)).toBe(true);
    expect(k1).not.toBe(k2);
    // One id is never a prefix match for another.
    expect(queuedKey(availabilityKeyPrefix('item10')).startsWith(a)).toBe(
      false,
    );
  });
});

describe('outletsForBranch', () => {
  it('sends without an outlet when the connection has no outlet map', () => {
    expect(outletsForBranch(undefined, 'b1')).toEqual([null]);
    expect(outletsForBranch({}, 'b1')).toEqual([null]);
  });

  it("returns only this branch's platform outlets", () => {
    const map = { 'out-a': 'b1', 'out-b': 'b2', 'out-c': 'b1' };
    expect(outletsForBranch(map, 'b1')).toEqual(['out-a', 'out-c']);
    expect(outletsForBranch(map, 'b2')).toEqual(['out-b']);
  });

  it('skips a branch that has no outlet on a mapped connection', () => {
    expect(outletsForBranch({ 'out-a': 'b1' }, 'b2')).toEqual([]);
  });
  it('keeps only the last change per item', () => {
    expect(
      toPlatformAvailability(
        [
          { menuItemId: 'a', available: false },
          { menuItemId: 'a', available: true },
          { menuItemId: 'b', available: false },
        ],
        { b: 'zom-b' },
      ),
    ).toEqual([
      { externalItemId: 'a', available: true },
      { externalItemId: 'zom-b', available: false },
    ]);
  });

  it('only pushes the menu for edits a platform shows', () => {
    expect(touchesMenu({ price: 10 })).toBe(true);
    expect(touchesMenu({ modifierGroupIds: [] })).toBe(true);
    expect(touchesMenu({ sortOrder: 3, isActive: false })).toBe(false);
  });
});

describe('buildMenu', () => {
  it('sends tax-inclusive prices straight from the menu', () => {
    const menu = buildMenu(
      [{ id: 'c1', name: 'Pizza' }],
      [
        {
          id: 'i1',
          name: 'Margherita',
          description: null,
          categoryId: 'c1',
          price: '249.00',
          halfPrice: '149.00',
          taxRatePercent: '5.00',
          isVeg: true,
          isActive: false,
          modifierGroups: [
            {
              modifierGroup: {
                modifiers: [
                  { id: 'm1', name: 'Cheese', priceAdjustment: '30' },
                ],
              },
            },
          ],
        },
      ],
      { i1: 'zom-1' },
      new Date('2026-11-04T10:00:00Z'),
    );
    expect(menu.items).toEqual([
      {
        externalItemId: 'zom-1',
        name: 'Margherita',
        description: null,
        categoryId: 'c1',
        price: 249,
        halfPrice: 149,
        taxRatePercent: 5,
        isVeg: true,
        available: false,
        modifiers: [{ id: 'm1', name: 'Cheese', price: 30 }],
      },
    ]);
    expect(menu.categories).toEqual([{ id: 'c1', name: 'Pizza' }]);
  });
});

describe('PartnerApiProvider menu calls against the mock partner', () => {
  let mock: AggregatorMock;
  let ctx: {
    restaurantId: string;
    externalAccountId: string | null;
    credentials: Record<string, string>;
  };
  const provider = new PartnerApiProvider({ timeoutMs: 300, net: NET });

  beforeEach(async () => {
    mock = new AggregatorMock({ apiKey: API_KEY, webhookSecret: SECRET });
    const baseUrl = await mock.start();
    ctx = {
      restaurantId: 'r1',
      externalAccountId: 'merchant-1',
      credentials: { baseUrl, apiKey: API_KEY, webhookSecret: SECRET },
    };
  });
  afterEach(() => mock.stop());

  it('switches an item off and back on', async () => {
    await provider.setItemAvailability(
      ctx,
      [{ externalItemId: 'zom-1', available: false }],
      { idempotencyKey: 'k1' },
    );
    expect(mock.availability).toEqual({ 'zom-1': false });
    expect(mock.calls.at(-1)!.signatureValid).toBe(true);
    await provider.setItemAvailability(
      ctx,
      [{ externalItemId: 'zom-1', available: true }],
      { idempotencyKey: 'k2' },
    );
    expect(mock.availability).toEqual({ 'zom-1': true });
  });

  it('is idempotent: a retried call with the same key is replayed, not re-applied', async () => {
    const items = [{ externalItemId: 'zom-1', available: false }];
    await provider.setItemAvailability(ctx, items, { idempotencyKey: 'k1' });
    await provider.setItemAvailability(ctx, items, { idempotencyKey: 'k1' });
    expect(mock.calls.at(-1)!.replayed).toBe(true);
  });

  it('publishes the menu payload as given', async () => {
    const menu = buildMenu([{ id: 'c1', name: 'Pizza' }], [], undefined);
    await provider.pushMenu(ctx, menu, { idempotencyKey: 'k3' });
    expect(mock.menu).toEqual(menu);
    expect(mock.calls.at(-1)!.method).toBe('PUT');
  });

  it('names the platform outlet when one is given', async () => {
    await provider.setItemAvailability(
      ctx,
      [{ externalItemId: 'zom-1', available: false }],
      { idempotencyKey: 'k5', outletId: 'out-a' },
    );
    expect(mock.availabilityByOutlet['out-a']).toEqual({ 'zom-1': false });
    const menu = buildMenu([{ id: 'c1', name: 'Pizza' }], [], undefined);
    await provider.pushMenu(ctx, menu, {
      idempotencyKey: 'k6',
      outletId: 'out-b',
    });
    expect(mock.menuByOutlet['out-b']).toEqual({ ...menu, outletId: 'out-b' });
    expect(mock.menuByOutlet['out-a']).toBeUndefined();
  });

  it('names our branch alongside the outlet, so a merchant without an outlet map can route by branch', async () => {
    await provider.setItemAvailability(
      ctx,
      [{ externalItemId: 'zom-2', available: false }],
      { idempotencyKey: 'k7', branchId: 'b1' },
    );
    expect(mock.availabilityByBranch['b1']).toEqual({ 'zom-2': false });
    const menu = buildMenu([{ id: 'c1', name: 'Pizza' }], [], undefined);
    await provider.pushMenu(ctx, menu, {
      idempotencyKey: 'k8',
      branchId: 'b2',
      outletId: 'out-b',
    });
    expect(mock.menuByBranch['b2']).toEqual({
      ...menu,
      branchId: 'b2',
      outletId: 'out-b',
    });
    expect(mock.menuByBranch['b1']).toBeUndefined();
  });

  it('reports a retryable error when the partner is down', async () => {
    mock.failNext('500');
    await expect(
      provider.setItemAvailability(ctx, [], { idempotencyKey: 'k4' }),
    ).rejects.toMatchObject({ retryable: true, httpStatus: 500 });
  });
});
