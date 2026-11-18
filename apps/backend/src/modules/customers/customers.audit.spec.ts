import { CustomersService } from './customers.service';

const setup = () => {
  const prisma = {
    customer: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new CustomersService(prisma as never, audit as never);
  return { prisma, audit, svc };
};

describe('CustomersService audit trail', () => {
  it('records customer.created with the actor', async () => {
    const { prisma, audit, svc } = setup();
    prisma.customer.create.mockResolvedValue({ id: 'c1', name: 'Ann' });
    await svc.create('b1', { name: 'Ann' }, 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'customer.created',
        entity: 'Customer',
        entityId: 'c1',
        metadata: expect.objectContaining({ branchId: 'b1', name: 'Ann' }),
      }),
    );
  });

  it('records customer.updated with before/after of changed fields only', async () => {
    const { prisma, audit, svc } = setup();
    prisma.customer.findFirst.mockResolvedValue({
      id: 'c1',
      name: 'Ann',
      phone: '1',
    });
    prisma.customer.update.mockResolvedValue({
      id: 'c1',
      name: 'Bea',
      phone: '1',
    });
    await svc.update('b1', 'c1', { name: 'Bea', phone: '1' }, 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'customer.updated',
        entityId: 'c1',
        metadata: expect.objectContaining({
          changes: { name: { before: 'Ann', after: 'Bea' } },
        }),
      }),
    );
  });

  it('records customer.deleted after the delete commits', async () => {
    const { prisma, audit, svc } = setup();
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', name: 'Ann' });
    await svc.remove('b1', 'c1', 'u1');
    expect(prisma.customer.delete).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'customer.deleted',
        entityId: 'c1',
      }),
    );
  });

  it('does not audit when the customer is not in the branch', async () => {
    const { prisma, audit, svc } = setup();
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(svc.remove('b1', 'x', 'u1')).rejects.toThrow(
      'Customer not found',
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
