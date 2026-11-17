import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

// DELETE /auth/me (#236 review): the password goes through the rate-limited
// checker, and the last-owner check runs in the same locked transaction as
// the write, like PATCH/DELETE /users/:id.

const owner = {
  id: 'o1',
  restaurantId: 'r1',
  passwordHash: 'hash',
  role: { name: 'OWNER' },
};

function setup(lockedOwners: { id: string }[], passwordOk = true) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(owner),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    },
    deviceToken: { deleteMany: jest.fn().mockResolvedValue({}) },
    notification: { deleteMany: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue(lockedOwners),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.resolve([]),
  );
  const passwordCheck = { verify: jest.fn().mockResolvedValue(passwordOk) };
  const svc = new AuthService(
    prisma as never,
    {} as never,
    {} as never,
    { record: jest.fn() } as never,
    passwordCheck as never,
  );
  return { svc, prisma, passwordCheck };
}

describe('AuthService.deleteOwnAccount', () => {
  it('checks the password through the rate-limited checker', async () => {
    const { svc, prisma, passwordCheck } = setup([{ id: 'o1' }], false);
    await expect(
      svc.deleteOwnAccount('o1', 'guess', '5.5.5.5'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwordCheck.verify).toHaveBeenCalledWith(
      owner,
      'guess',
      '5.5.5.5',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses the last active owner, as seen under the row lock', async () => {
    const { svc, prisma } = setup([{ id: 'o1' }]);
    await expect(
      svc.deleteOwnAccount('o1', 'pw', '5.5.5.5'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('closes the account inside the locked transaction when another owner remains', async () => {
    const { svc, prisma } = setup([{ id: 'o1' }, { id: 'o2' }]);
    await svc.deleteOwnAccount('o1', 'pw', '5.5.5.5');
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });
});
