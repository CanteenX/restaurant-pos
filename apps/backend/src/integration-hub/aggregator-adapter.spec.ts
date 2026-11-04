// Aggregator adapter (#58): payload mapping, outbound retries, idempotency.
// The partner side is the in-process AggregatorMock (test/mocks), so no
// credentials or network are needed.
import { UnprocessableEntityException } from '@nestjs/common';
import { AggregatorMock } from '../../test/mocks/aggregator-mock';
import {
  isPriceMismatch,
  matchLines,
  platformMoneyNote,
  resolveBranch,
} from './aggregator-mapping';
import {
  afterFailure,
  orderStatusDedupeKey,
  toOutboundError,
} from './outbox/outbox-policy';
import { PartnerApiProvider } from './providers/partner-api.provider';
import { OutboundError } from './providers/provider';
import { getProvider, sourceOf, supports } from './providers/registry';

const API_KEY = 'key_adapter_test';
const SECRET = 'whsec_adapter_0123456789';
const NET = { allowPrivate: true, allowInsecure: true };

describe('aggregator mapping', () => {
  const menu = [
    {
      id: 'm-pizza',
      name: 'Margherita',
      modifiers: [
        { id: 'mod-cheese', name: 'Extra Cheese' },
        { id: 'mod-olive', name: 'Olives' },
      ],
    },
    { id: 'm-tea', name: 'Masala Tea', modifiers: [] },
  ];

  it('matches dishes by id or case-insensitive name, and add-ons on that dish', () => {
    const r = matchLines(
      [
        {
          name: ' margherita ',
          quantity: 2,
          modifiers: [{ name: 'extra cheese' }, { modifierId: 'mod-olive' }],
        },
        { menuItemId: 'm-tea', quantity: 1, kitchenNote: 'less sugar' },
      ],
      menu,
    );
    expect(r.unmatched).toEqual([]);
    expect(r.lines).toEqual([
      {
        menuItemId: 'm-pizza',
        quantity: 2,
        modifierIds: ['mod-cheese', 'mod-olive'],
        kitchenNote: undefined,
      },
      {
        menuItemId: 'm-tea',
        quantity: 1,
        modifierIds: [],
        kitchenNote: 'less sugar',
      },
    ]);
  });

  it('reports unknown dishes and add-ons that do not belong to the dish', () => {
    const r = matchLines(
      [
        { name: 'Biryani', quantity: 1 },
        // Olives exist, but only on the pizza.
        { menuItemId: 'm-tea', quantity: 1, modifiers: [{ name: 'Olives' }] },
      ],
      menu,
    );
    expect(r.unmatched).toEqual(['Biryani', 'Masala Tea + Olives']);
  });

  it('resolves the branch from branchId, the outlet map, or a single branch', () => {
    const outlets = { 'zom-55': 'b2' };
    expect(resolveBranch({ branchId: 'b1' }, ['b1', 'b2'], outlets)).toBe('b1');
    expect(resolveBranch({ outletId: 'zom-55' }, ['b1', 'b2'], outlets)).toBe(
      'b2',
    );
    expect(resolveBranch({}, ['b1'], {})).toBe('b1');
    expect(() => resolveBranch({ branchId: 'x' }, ['b1'], {})).toThrow(
      UnprocessableEntityException,
    );
    expect(() =>
      resolveBranch({ outletId: 'unknown' }, ['b1', 'b2'], outlets),
    ).toThrow(/outlet/i);
    // An outlet mapped to a branch of another restaurant is refused.
    expect(() =>
      resolveBranch({ outletId: 'zom-55' }, ['b1'], outlets),
    ).toThrow(UnprocessableEntityException);
    expect(() => resolveBranch({}, ['b1', 'b2'], {})).toThrow(/branchId/);
  });

  it('records platform money but never trusts it, and flags drift over 1.00', () => {
    expect(
      platformMoneyNote({
        platformTotal: 512.5,
        packagingCharge: 20,
        platformDiscount: 50,
      }),
    ).toBe('platform total 512.50, packaging 20.00, platform discount 50.00');
    expect(platformMoneyNote({})).toBe('');
    expect(isPriceMismatch(500, '500.00')).toBe(false);
    expect(isPriceMismatch(501, '500.00')).toBe(false);
    expect(isPriceMismatch(501.01, '500.00')).toBe(true);
    expect(isPriceMismatch(undefined, '500.00')).toBe(false);
  });
});

describe('outbox policy', () => {
  const now = new Date('2026-11-04T00:00:00Z');

  it('dedupes one status per platform order', () => {
    expect(orderStatusDedupeKey('zc-1', 'READY')).toBe(
      'order.status:zc-1:READY',
    );
  });

  it('retries retryable failures with backoff, then gives up', () => {
    const err = new OutboundError('HTTP 500', true, 500);
    const first = afterFailure(1, err, now);
    expect(first.status).toBe('PENDING');
    expect(first.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect(afterFailure(2, err, now).nextAttemptAt.getTime()).toBe(
      now.getTime() + 5 * 60_000,
    );
    expect(afterFailure(6, err, now).status).toBe('DEAD');
  });

  it('dead-letters non-retryable failures at once', () => {
    expect(
      afterFailure(1, new OutboundError('HTTP 400', false, 400), now),
    ).toMatchObject({ status: 'DEAD' });
  });

  it('treats unknown errors as retryable', () => {
    const e = toOutboundError(new Error('socket hang up'));
    expect(e).toBeInstanceOf(OutboundError);
    expect(e.retryable).toBe(true);
  });
});

describe('registry', () => {
  it('registers the partner API adapter with status updates, and keeps the plain webhook inbound-only', () => {
    const p = getProvider('partner-api')!;
    expect(p).toBeInstanceOf(PartnerApiProvider);
    expect(supports(p, 'updateOrderStatus')).toBe(true);
    expect(supports(p, 'cancelOrders')).toBe(true);
    expect(supports(p, 'itemAvailability')).toBe(false);
    expect(sourceOf(p)).toBe('partner-api');
    const secretKeys = p.credentialFields
      .filter((f) => f.secret)
      .map((f) => f.key);
    expect(secretKeys).toEqual(['apiKey', 'webhookSecret']);
    expect(supports(getProvider('zomato')!, 'updateOrderStatus')).toBe(false);
  });
});

describe('PartnerApiProvider against the mock partner', () => {
  let mock: AggregatorMock;
  let ctx: {
    restaurantId: string;
    externalAccountId: string | null;
    credentials: Record<string, string>;
  };
  const provider = new PartnerApiProvider({ timeoutMs: 300, net: NET });
  const send = (key = 'k1', status: 'ACCEPTED' | 'READY' = 'ACCEPTED') =>
    provider.updateOrderStatus(ctx, 'zc-1', status, {
      idempotencyKey: key,
      at: '2026-11-04T00:00:00.000Z',
    });

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

  it('sends a signed, keyed status call the partner accepts', async () => {
    await send();
    expect(mock.orderStatuses('zc-1')).toEqual(['ACCEPTED']);
    const call = mock.calls.at(-1)!;
    expect(call.signatureValid).toBe(true);
    expect(call.headers['idempotency-key']).toBe('k1');
    expect(call.body).toEqual({
      status: 'ACCEPTED',
      at: '2026-11-04T00:00:00.000Z',
    });
  });

  it('is idempotent: a retried call with the same key is not applied twice', async () => {
    await send('same');
    await send('same');
    expect(mock.orderStatuses('zc-1')).toEqual(['ACCEPTED']);
    expect(mock.calls.at(-1)!.replayed).toBe(true);
  });

  it.each([
    ['500', true, 500],
    ['429', true, 429],
    ['401', false, 401],
  ] as const)('maps a %s to retryable=%s', async (mode, retryable, http) => {
    mock.failNext(mode);
    const err = (await send().catch((e: unknown) => e)) as OutboundError;
    expect(err).toBeInstanceOf(OutboundError);
    expect(err.retryable).toBe(retryable);
    expect(err.httpStatus).toBe(http);
    expect(mock.orderStatuses('zc-1')).toEqual([]);
  });

  it('times out a partner that never answers, as retryable', async () => {
    mock.failNext('timeout');
    const err = (await send().catch((e: unknown) => e)) as OutboundError;
    expect(err).toBeInstanceOf(OutboundError);
    expect(err.retryable).toBe(true);
  });

  it('refuses a private address unless the network policy allows it', async () => {
    const strict = new PartnerApiProvider({
      timeoutMs: 300,
      net: { allowPrivate: false, allowInsecure: true },
    });
    const err = (await strict
      .updateOrderStatus(ctx, 'zc-1', 'READY', { idempotencyKey: 'x', at: '' })
      .catch((e: unknown) => e)) as OutboundError;
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/private/);
    expect(mock.calls).toHaveLength(0);
  });

  it('tests the connection honestly', async () => {
    expect(await provider.testConnection(ctx)).toMatchObject({
      ok: true,
      status: 'CONNECTED',
    });
    expect(
      await provider.testConnection({
        ...ctx,
        credentials: { ...ctx.credentials, apiKey: 'wrong' },
      }),
    ).toMatchObject({ ok: false, status: 'AUTH_EXPIRED' });
    mock.failNext('500');
    expect(await provider.testConnection(ctx)).toMatchObject({
      ok: false,
      status: 'SYNC_ERROR',
    });
  });
});
