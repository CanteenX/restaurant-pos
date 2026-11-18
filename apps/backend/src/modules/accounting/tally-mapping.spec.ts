import { TALLY_LEDGER_DEFAULTS, tallyMappingSchema } from '@nventra/types';
import { TallyMappingService, resolveMapping } from './tally-mapping.service';

type Where = { restaurantId_provider: { restaurantId: string } };
type UpsertArgs = {
  where: Where;
  create: { config: unknown };
  update: { config: unknown };
};

function makePrisma() {
  const rows = new Map<string, { config: unknown }>();
  const key = (w: { restaurantId_provider: { restaurantId: string } }) =>
    w.restaurantId_provider.restaurantId;
  return {
    integrationConnection: {
      findUnique: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(rows.get(key(where)) ?? null),
      ),
      upsert: jest.fn(({ where, create, update }: UpsertArgs) => {
        const k = key(where);
        rows.set(k, rows.has(k) ? { config: update.config } : create);
        return Promise.resolve(rows.get(k));
      }),
    },
  };
}

describe('Tally ledger mapping', () => {
  it('returns defaults when nothing is stored', async () => {
    const svc = new TallyMappingService(makePrisma() as never);
    expect(await svc.get('r1')).toEqual(TALLY_LEDGER_DEFAULTS);
  });

  it('merges overrides over defaults and persists them', async () => {
    const svc = new TallyMappingService(makePrisma() as never);
    const saved = await svc.save('r1', { sales: 'Food Sales', upi: 'Paytm' });
    expect(saved.sales).toBe('Food Sales');
    expect(saved.cash).toBe(TALLY_LEDGER_DEFAULTS.cash);
    expect(await svc.get('r1')).toEqual(saved);
    await svc.save('r1', { cash: 'Till' });
    expect((await svc.get('r1')).sales).toBe('Food Sales');
  });

  it('is scoped per restaurant', async () => {
    const svc = new TallyMappingService(makePrisma() as never);
    await svc.save('r1', { sales: 'A' });
    expect((await svc.get('r2')).sales).toBe(TALLY_LEDGER_DEFAULTS.sales);
  });

  it('validates names', () => {
    expect(tallyMappingSchema.safeParse({ sales: '  ' }).success).toBe(false);
    expect(tallyMappingSchema.safeParse({ sales: 'A & B' }).success).toBe(
      false,
    );
    expect(tallyMappingSchema.safeParse({ bogus: 'x' }).success).toBe(false);
    expect(tallyMappingSchema.safeParse({ sales: ' Food ' }).data).toEqual({
      sales: 'Food',
    });
  });

  it('falls back to defaults on corrupt stored config', () => {
    expect(resolveMapping({ sales: 42 })).toEqual(TALLY_LEDGER_DEFAULTS);
  });
});
