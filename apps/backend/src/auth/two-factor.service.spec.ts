/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { base32Decode, generateSecret, hotp, sealSecret, stepAt } from './totp';
import { TwoFactorService } from './two-factor.service';

const KEY = 'unit-test-key';

const ceilingRole = (name: string, keys: string[]) => ({
  name,
  permissions: keys.map((key) => ({ permission: { key } })),
});
const staffTarget = (name: string, keys: string[]) => ({
  id: 'u2',
  role: ceilingRole(name, keys),
  permissionOverrides: [],
});
const OWNER_ACTOR = {
  id: 'owner',
  roleName: 'OWNER',
  permissions: ['users.manage'],
};
const STAFF_MGR_ACTOR = {
  id: 'mgr',
  roleName: 'STAFF_MGR',
  permissions: ['users.manage'],
};

const actorRow = (id: string, name: string) => ({
  id,
  isActive: true,
  role: ceilingRole(name, ['users.manage']),
  permissionOverrides: [],
});
const ACTOR_ROWS: Record<string, unknown> = {
  owner: actorRow('owner', 'OWNER'),
  mgr: actorRow('mgr', 'STAFF_MGR'),
};

function setup(
  lastStep: number | null = null,
  updateCount = 1,
  target: unknown = staffTarget('WAITER', []),
) {
  const secret = generateSecret();
  const user = {
    id: 'u1',
    twoFactorEnabled: true,
    twoFactorSecret: sealSecret(secret, KEY),
    twoFactorRecoveryHashes: [] as string[],
    twoFactorLastStep: lastStep,
  };
  const prisma = {
    user: {
      updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      update: jest.fn().mockResolvedValue({}),
      // Actors are re-read from the DB (#236); anyone else is `target`.
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(ACTOR_ROWS[where.id] ?? target),
      ),
    },
  };
  const sessions = { revokeAll: jest.fn().mockResolvedValue(1) };
  const config = {
    get: (k: string) => (k === 'TWO_FACTOR_KEY' ? KEY : undefined),
    getOrThrow: () => KEY,
  };
  const svc = new TwoFactorService(
    prisma as never,
    config as never,
    { record: jest.fn() } as never,
    sessions as never,
    { verify: jest.fn().mockResolvedValue(true) } as never,
  );
  const codeAt = (offset = 0) =>
    hotp(base32Decode(secret), stepAt(Date.now()) + offset);
  return { svc, user, prisma, codeAt, sessions };
}

describe('TwoFactorService.verifyLogin', () => {
  it('accepts a valid code and records its step', async () => {
    const { svc, user, prisma, codeAt } = setup();
    await expect(svc.verifyLogin(user, codeAt())).resolves.toBeUndefined();
    expect(prisma.user.updateMany.mock.calls[0][0].data.twoFactorLastStep).toBe(
      stepAt(Date.now()),
    );
  });

  it('asks for a code when none is given', async () => {
    const { svc, user } = setup();
    await expect(svc.verifyLogin(user, undefined)).rejects.toThrow(
      'TWO_FACTOR_REQUIRED',
    );
  });

  it('rejects a code from a step already used (replay)', async () => {
    const { svc, user, codeAt } = setup(stepAt(Date.now()));
    await expect(svc.verifyLogin(user, codeAt())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when a concurrent request already consumed the step', async () => {
    const { svc, user, codeAt } = setup(null, 0); // updateMany matched nothing
    await expect(svc.verifyLogin(user, codeAt())).rejects.toThrow(
      'Invalid verification code',
    );
  });

  it('locks the account after 5 wrong codes, even for a right one', async () => {
    const { svc, user, codeAt } = setup();
    for (let i = 0; i < 5; i++) {
      await expect(svc.verifyLogin(user, '000000')).rejects.toThrow(
        'Invalid verification code',
      );
    }
    await expect(svc.verifyLogin(user, codeAt())).rejects.toThrow(/Too many/);
  });
});

describe('TwoFactorService.adminReset', () => {
  it('ends every session of the staff member being reset', async () => {
    const { svc, sessions } = setup();
    await svc.adminReset(OWNER_ACTOR, 'r1', 'u2');
    expect(sessions.revokeAll).toHaveBeenCalledWith('u2');
  });

  it("a staff manager cannot reset the owner's 2FA (#229)", async () => {
    const { svc, prisma, sessions } = setup(
      null,
      1,
      staffTarget('OWNER', ['users.manage']),
    );
    await expect(
      svc.adminReset(STAFF_MGR_ACTOR, 'r1', 'u2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
  });

  it("a staff manager cannot reset a higher user's 2FA (#229)", async () => {
    const { svc, prisma } = setup(
      null,
      1,
      staffTarget('HIGH', ['users.manage', 'reports.access']),
    );
    await expect(
      svc.adminReset(STAFF_MGR_ACTOR, 'r1', 'u2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a staff manager cannot reset a same-level user (#236)', async () => {
    const { svc, prisma, sessions } = setup(
      null,
      1,
      staffTarget('STAFF_MGR', ['users.manage']),
    );
    await expect(svc.adminReset(STAFF_MGR_ACTOR, 'r1', 'u2')).rejects.toThrow(
      /less access/,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAll).not.toHaveBeenCalled();
  });

  it('a staff manager can reset a strictly lower user', async () => {
    const { svc, sessions } = setup(null, 1, staffTarget('WAITER', []));
    await svc.adminReset(STAFF_MGR_ACTOR, 'r1', 'u2');
    expect(sessions.revokeAll).toHaveBeenCalledWith('u2');
  });

  it("the owner can reset another owner's 2FA", async () => {
    const { svc, sessions } = setup(
      null,
      1,
      staffTarget('OWNER', ['users.manage']),
    );
    await svc.adminReset(OWNER_ACTOR, 'r1', 'u2');
    expect(sessions.revokeAll).toHaveBeenCalledWith('u2');
  });
});

describe('TwoFactorService.disable password check (#236 review)', () => {
  it('goes through the rate-limited checker and refuses a wrong password', async () => {
    const row = { id: 'u1', twoFactorEnabled: true, passwordHash: 'h' };
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(row),
        update: jest.fn(),
      },
    };
    const passwordCheck = { verify: jest.fn().mockResolvedValue(false) };
    const svc = new TwoFactorService(
      prisma as never,
      { get: () => KEY, getOrThrow: () => KEY } as never,
      { record: jest.fn() } as never,
      { revokeAll: jest.fn() } as never,
      passwordCheck as never,
    );
    await expect(
      svc.disable('u1', 'guess', '123456', '4.4.4.4'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(passwordCheck.verify).toHaveBeenCalledWith(row, 'guess', '4.4.4.4');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
