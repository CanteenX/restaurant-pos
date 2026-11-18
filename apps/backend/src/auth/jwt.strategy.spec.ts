/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';

function setup(user: Record<string, unknown> | null) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
  const config = {
    get: (k: string) =>
      ({ SESSION_IDLE_MINUTES: '60', SESSION_MAX_HOURS: '12' })[k],
    getOrThrow: () => 'unit-test-secret',
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('fresh-token') };
  const strategy = new JwtStrategy(
    config as never,
    prisma as never,
    jwt as unknown as JwtService,
  );
  const res = { cookie: jest.fn() };
  const req = { res };
  return { strategy, req, res, jwt };
}

const activeUser = (tokenVersion = 0) => ({
  id: 'u1',
  restaurantId: 'r1',
  name: 'A',
  roleId: 'role1',
  isActive: true,
  tokenVersion,
  role: { name: 'OWNER', permissions: [] },
  permissionOverrides: [],
});

const now = () => Math.floor(Date.now() / 1000);

describe('JwtStrategy.validate', () => {
  it('accepts a token whose tv matches the user tokenVersion', async () => {
    const { strategy, req } = setup(activeUser(2));
    const u = await strategy.validate(req as never, {
      sub: 'u1',
      tv: 2,
      exp: now() + 3500,
    });
    expect(u.id).toBe('u1');
  });

  it('rejects a token with an old tokenVersion', async () => {
    const { strategy, req } = setup(activeUser(3));
    await expect(
      strategy.validate(req as never, { sub: 'u1', tv: 2, exp: now() + 3500 }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('treats a pre-rollout token without tv as version 0', async () => {
    const { strategy, req } = setup(activeUser(0));
    await expect(
      strategy.validate(req as never, { sub: 'u1', exp: now() + 3500 }),
    ).resolves.toMatchObject({ id: 'u1' });
    const { strategy: s2, req: r2 } = setup(activeUser(1));
    await expect(
      s2.validate(r2 as never, { sub: 'u1', exp: now() + 3500 }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an inactive user', async () => {
    const { strategy, req } = setup({ ...activeUser(), isActive: false });
    await expect(
      strategy.validate(req as never, { sub: 'u1', tv: 0, exp: now() + 3500 }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('slides the session: re-issues the cookie past half the idle window', async () => {
    const { strategy, req, res, jwt } = setup(activeUser(4));
    const authTime = now() - 3600;
    await strategy.validate(req as never, {
      sub: 'u1',
      tv: 4,
      exp: now() + 600,
      auth_time: authTime,
    });
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: 'u1', tv: 4, auth_time: authTime },
      { expiresIn: 3600 },
    );
    expect(res.cookie.mock.calls[0][0]).toBe('nventra_session');
    expect(res.cookie.mock.calls[0][1]).toBe('fresh-token');
    expect(res.cookie.mock.calls[0][2]).toMatchObject({
      httpOnly: true,
      maxAge: 3600 * 1000,
    });
  });

  it('does not re-issue a fresh cookie', async () => {
    const { strategy, req, res } = setup(activeUser());
    await strategy.validate(req as never, {
      sub: 'u1',
      tv: 0,
      exp: now() + 3500,
    });
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rejects a token past the absolute session cap even if exp is valid', async () => {
    const { strategy, req, res } = setup(activeUser());
    await expect(
      strategy.validate(req as never, {
        sub: 'u1',
        tv: 0,
        exp: now() + 600,
        auth_time: now() - 13 * 3600,
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('falls back to iat for the cap on pre-rollout tokens', async () => {
    const { strategy, req } = setup(activeUser());
    await expect(
      strategy.validate(req as never, {
        sub: 'u1',
        tv: 0,
        exp: now() + 600,
        iat: now() - 13 * 3600,
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('carries auth_time over and never slides past the cap', async () => {
    const { strategy, req, res, jwt } = setup(activeUser());
    const authTime = now() - (12 * 3600 - 900); // 15 min left on the cap
    await strategy.validate(req as never, {
      sub: 'u1',
      tv: 0,
      exp: now() + 600,
      auth_time: authTime,
    });
    const [claims, opts] = jwt.signAsync.mock.calls[0];
    expect(claims).toEqual({ sub: 'u1', tv: 0, auth_time: authTime });
    expect(opts.expiresIn).toBeGreaterThan(890);
    expect(opts.expiresIn).toBeLessThanOrEqual(900);
    expect(res.cookie.mock.calls[0][2].maxAge).toBe(opts.expiresIn * 1000);
  });
});
