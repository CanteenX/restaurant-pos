import { ReservationsService } from './reservations.service';

const setup = () => {
  const tx = {
    reservation: { create: jest.fn(), update: jest.fn() },
    table: { update: jest.fn() },
  };
  const prisma = {
    reservation: { findFirst: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new ReservationsService(
    prisma as never,
    { emitToBranch: jest.fn() } as never,
    { notifyByPermission: jest.fn().mockResolvedValue(undefined) } as never,
    { emitForBranch: jest.fn().mockResolvedValue(undefined) } as never,
    audit as never,
  );
  return { tx, prisma, audit, svc };
};

describe('ReservationsService audit trail', () => {
  it('records reservation.created with the staff actor', async () => {
    const { tx, audit, svc } = setup();
    tx.reservation.create.mockResolvedValue({
      id: 'r1',
      customerName: 'Ann',
      guestCount: 2,
      reservedAt: new Date(),
      channel: 'STAFF',
    });
    await svc.create('b1', { customerName: 'Ann', guestCount: 2 } as never, {
      actorId: 'u1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'reservation.created',
        entity: 'Reservation',
        entityId: 'r1',
      }),
    );
  });

  it('records online bookings with no actor', async () => {
    const { tx, prisma, audit, svc } = setup();
    (prisma as Record<string, unknown>).table = {
      findMany: jest.fn().mockResolvedValue([]),
    };
    (prisma as Record<string, unknown>).branch = {
      findUnique: jest.fn().mockResolvedValue(null),
    };
    tx.reservation.create.mockResolvedValue({
      id: 'r2',
      customerName: 'Web',
      guestCount: 2,
      reservedAt: new Date(),
      channel: 'ONLINE',
    });
    await svc.create('b1', { customerName: 'Web', guestCount: 2 } as never, {
      fromWebsite: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, action: 'reservation.created' }),
    );
  });

  it('records reservation.status_changed with before/after status', async () => {
    const { tx, prisma, audit, svc } = setup();
    prisma.reservation.findFirst.mockResolvedValue({
      id: 'r1',
      status: 'PENDING',
    });
    tx.reservation.update.mockResolvedValue({
      id: 'r1',
      status: 'CANCELLED',
      tableId: null,
    });
    await svc.updateStatus('b1', 'r1', 'CANCELLED', 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'reservation.status_changed',
        entityId: 'r1',
        metadata: expect.objectContaining({ from: 'PENDING', to: 'CANCELLED' }),
      }),
    );
  });
});
