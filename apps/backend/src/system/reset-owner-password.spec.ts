import * as bcrypt from 'bcrypt';
import {
  generatePassword,
  parseResetArgs,
  resetOwnerPassword,
} from './reset-owner-password';

// Owner password recovery from the server shell (#236 review): the sole
// owner who forgot their password, until email reset (#224) lands.

const owner = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  restaurantId: 'r1',
  isActive: true,
  role: { name: 'OWNER' },
  ...over,
});

function prismaWith(found: unknown[]) {
  return {
    user: {
      findMany: jest.fn().mockResolvedValue(found),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('parseResetArgs', () => {
  it('reads --email and an optional --restaurant', () => {
    expect(parseResetArgs(['--email', 'Boss@X.com'])).toEqual({
      email: 'boss@x.com',
    });
    expect(
      parseResetArgs(['--', '--email=a@b.co', '--restaurant', 'r9']),
    ).toEqual({ email: 'a@b.co', restaurantId: 'r9' });
  });

  it('rejects a missing or invalid email', () => {
    expect(() => parseResetArgs([])).toThrow(/--email/);
    expect(() => parseResetArgs(['--email', 'nope'])).toThrow(/--email/);
  });
});

describe('generatePassword', () => {
  it('is long and different every time', () => {
    const a = generatePassword();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(generatePassword()).not.toBe(a);
  });
});

describe('resetOwnerPassword', () => {
  it('sets the new password, ends every session and audits it', async () => {
    const prisma = prismaWith([owner()]);
    await resetOwnerPassword(prisma as never, {
      email: 'boss@x.com',
      newPassword: 'Fresh-pass-123',
    });
    const { where, data } = prisma.user.update.mock.calls[0][0] as {
      where: { id: string };
      data: { passwordHash: string; tokenVersion: unknown };
    };
    expect(where).toEqual({ id: 'o1' });
    expect(data.tokenVersion).toEqual({ increment: 1 });
    expect(await bcrypt.compare('Fresh-pass-123', data.passwordHash)).toBe(
      true,
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'o1',
        action: 'owner.password_reset_cli',
      }),
    });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      'Fresh-pass-123',
    );
  });

  it('matches the email case-insensitively, within --restaurant when given', async () => {
    const prisma = prismaWith([owner()]);
    await resetOwnerPassword(prisma as never, {
      email: 'boss@x.com',
      restaurantId: 'r1',
      newPassword: 'Fresh-pass-123',
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: { equals: 'boss@x.com', mode: 'insensitive' },
          restaurantId: 'r1',
        },
      }),
    );
  });

  it('only resets an OWNER account', async () => {
    const prisma = prismaWith([owner({ role: { name: 'CASHIER' } })]);
    await expect(
      resetOwnerPassword(prisma as never, {
        email: 'c@x.com',
        newPassword: 'Fresh-pass-123',
      }),
    ).rejects.toThrow(/not an owner/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses no match, or several restaurants without --restaurant', async () => {
    await expect(
      resetOwnerPassword(prismaWith([]) as never, {
        email: 'x@x.com',
        newPassword: 'Fresh-pass-123',
      }),
    ).rejects.toThrow(/No account/);
    await expect(
      resetOwnerPassword(
        prismaWith([owner(), owner({ id: 'o2', restaurantId: 'r2' })]) as never,
        { email: 'x@x.com', newPassword: 'Fresh-pass-123' },
      ),
    ).rejects.toThrow(/--restaurant/);
  });

  it('refuses a password shorter than 8 characters', async () => {
    const prisma = prismaWith([owner()]);
    await expect(
      resetOwnerPassword(prisma as never, {
        email: 'boss@x.com',
        newPassword: 'short',
      }),
    ).rejects.toThrow(/8/);
  });
});
