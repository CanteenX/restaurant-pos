// Aggregator menu and availability sync (#59): payload building, dedupe keys
// and the partner calls against the in-process mock partner.
import { AggregatorMock } from '../../test/mocks/aggregator-mock';
import {
  availabilityDedupeKey,
  buildMenu,
  externalItemId,
  menuPushDedupeKey,
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

  it('collapses repeats within a minute but not across states or minutes', () => {
    const t = new Date('2026-11-04T10:00:10Z');
    const same = new Date('2026-11-04T10:00:50Z');
    const later = new Date('2026-11-04T10:01:05Z');
    expect(availabilityDedupeKey('a', false, t)).toBe(
      availabilityDedupeKey('a', false, same),
    );
    expect(availabilityDedupeKey('a', false, t)).not.toBe(
      availabilityDedupeKey('a', true, t),
    );
    expect(availabilityDedupeKey('a', false, t)).not.toBe(
      availabilityDedupeKey('a', false, later),
    );
    expect(menuPushDedupeKey('br', t)).toBe(menuPushDedupeKey('br', same));
    expect(menuPushDedupeKey('br', t)).not.toBe(menuPushDedupeKey('br', later));
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

  it('reports a retryable error when the partner is down', async () => {
    mock.failNext('500');
    await expect(
      provider.setItemAvailability(ctx, [], { idempotencyKey: 'k4' }),
    ).rejects.toMatchObject({ retryable: true, httpStatus: 500 });
  });
});
