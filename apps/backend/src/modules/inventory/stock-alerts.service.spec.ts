import {
  StockAlertsService,
  expiryCutoff,
  buildDigest,
} from './stock-alerts.service';

describe('expiryCutoff', () => {
  it('adds the window in days', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    expect(expiryCutoff(now, 7).toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(expiryCutoff(now, 0).toISOString()).toBe(now.toISOString());
  });
});

describe('buildDigest', () => {
  it('returns null when nothing to report', () => {
    expect(buildDigest([], [])).toBeNull();
  });
  it('lists expiring batches and low stock', () => {
    const d = buildDigest(
      [
        {
          name: 'Milk',
          batchNumber: 'B1',
          expiryDate: new Date('2026-11-05T00:00:00Z'),
          quantity: 4,
        },
      ],
      [{ name: 'Flour', currentStock: 1, reorderLevel: 5 }],
    );
    expect(d?.expiryBody).toContain('Milk');
    expect(d?.lowBody).toContain('Flour');
  });
});

function makeService(opts: { smtp: boolean; existing: boolean }) {
  const created: unknown[] = [];
  const prisma = {
    restaurant: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'r1', expiryAlertDays: 7, branches: [{ id: 'b1' }] },
        ]),
    },
    stockBatch: {
      findMany: jest.fn().mockResolvedValue([
        {
          batchNumber: 'B1',
          quantityRemaining: 4,
          expiryDate: new Date('2026-11-05T00:00:00Z'),
          ingredient: { name: 'Milk' },
        },
      ]),
    },
    ingredient: {
      findMany: jest.fn().mockResolvedValue([
        { name: 'Flour', currentStock: 1, reorderLevel: 5 },
        { name: 'Salt', currentStock: 9, reorderLevel: 5 },
      ]),
    },
    notification: {
      count: jest.fn().mockResolvedValue(opts.existing ? 1 : 0),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ email: 'o@x.com' }]) },
  };
  const notifications = {
    notifyByPermission: jest.fn().mockImplementation((...a) => created.push(a)),
  };
  const email = {
    isConfigured: () => opts.smtp,
    sendEach: jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  };
  const time = { tzForBranch: jest.fn().mockResolvedValue('UTC') };
  const svc = new StockAlertsService(
    prisma as never,
    notifications as never,
    email as never,
    time as never,
  );
  return { svc, notifications, email, created };
}

describe('StockAlertsService.run', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  it('notifies for expiry and low stock', async () => {
    const { svc, notifications } = makeService({ smtp: true, existing: false });
    await svc.run(now);
    expect(notifications.notifyByPermission).toHaveBeenCalledTimes(2);
  });
  it('does not duplicate when already sent today', async () => {
    const { svc, notifications, email } = makeService({
      smtp: true,
      existing: true,
    });
    await svc.run(now);
    expect(notifications.notifyByPermission).not.toHaveBeenCalled();
    expect(email.sendEach).not.toHaveBeenCalled();
  });
  it('sends no email when SMTP is not configured', async () => {
    const { svc, email, notifications } = makeService({
      smtp: false,
      existing: false,
    });
    await svc.run(now);
    expect(notifications.notifyByPermission).toHaveBeenCalled();
    expect(email.sendEach).not.toHaveBeenCalled();
  });
  it('emails the digest when SMTP is configured', async () => {
    const { svc, email } = makeService({ smtp: true, existing: false });
    await svc.run(now);
    expect(email.sendEach).toHaveBeenCalledTimes(1);
  });
});
