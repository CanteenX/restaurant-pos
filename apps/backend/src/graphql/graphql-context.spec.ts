import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
import {
  buildGraphqlContext,
  requireAccess,
  scopedBranchId,
} from './graphql-context';

const staff: SessionUser = {
  id: 'u1',
  restaurantId: 'r-staff',
  name: 'Owner',
  roleId: 'role',
  roleName: 'OWNER',
  permissions: ['menu.manage'],
};
const key = {
  id: 'k1',
  restaurantId: 'r-key',
  branchId: null,
  scopes: ['menu:read'],
};

describe('buildGraphqlContext', () => {
  it('takes the tenant from an integration key', () => {
    const ctx = buildGraphqlContext({ integrationKey: key });
    expect(ctx).toMatchObject({
      restaurantId: 'r-key',
      branchId: null,
      principal: { kind: 'integration', id: 'k1' },
    });
  });

  it('takes the tenant from a staff session', () => {
    const ctx = buildGraphqlContext({ user: staff });
    expect(ctx).toMatchObject({
      restaurantId: 'r-staff',
      branchId: null,
      principal: { kind: 'staff', id: 'u1' },
    });
  });

  it('never trusts a client-supplied restaurant id', () => {
    const req = {
      integrationKey: key,
      headers: { 'x-restaurant-id': 'r-evil' },
      body: { variables: { restaurantId: 'r-evil' } },
    };
    expect(buildGraphqlContext(req).restaurantId).toBe('r-key');
  });

  it('prefers the integration key when both are somehow present', () => {
    const ctx = buildGraphqlContext({ integrationKey: key, user: staff });
    expect(ctx.principal.kind).toBe('integration');
    expect(ctx.restaurantId).toBe('r-key');
  });

  it('rejects a request with no principal', () => {
    expect(() => buildGraphqlContext({})).toThrow(UnauthorizedException);
  });

  it('rejects a principal without a restaurant', () => {
    expect(() =>
      buildGraphqlContext({ integrationKey: { ...key, restaurantId: '' } }),
    ).toThrow(UnauthorizedException);
  });

  it('freezes the context so resolvers cannot retarget the tenant', () => {
    const ctx = buildGraphqlContext({ integrationKey: key });
    expect(() => {
      (ctx as { restaurantId: string }).restaurantId = 'r-evil';
    }).toThrow(TypeError);
  });
});

describe('scopedBranchId', () => {
  const locked = buildGraphqlContext({
    integrationKey: { ...key, branchId: 'b1' },
  });
  const open = buildGraphqlContext({ integrationKey: key });

  it('defaults a branch-locked key to its branch', () => {
    expect(scopedBranchId(locked, undefined)).toBe('b1');
    expect(scopedBranchId(locked, 'b1')).toBe('b1');
  });

  it('refuses another branch for a branch-locked key', () => {
    expect(() => scopedBranchId(locked, 'b2')).toThrow(ForbiddenException);
  });

  it('passes the requested branch through for an unlocked principal', () => {
    expect(scopedBranchId(open, 'b2')).toBe('b2');
    expect(scopedBranchId(open, undefined)).toBeNull();
  });
});

describe('requireAccess', () => {
  it('checks integration scopes for keys', () => {
    const ctx = buildGraphqlContext({ integrationKey: key });
    expect(() =>
      requireAccess(ctx, { scope: 'menu:read', permission: 'menu.manage' }),
    ).not.toThrow();
    expect(() =>
      requireAccess(ctx, { scope: 'orders:read', permission: 'menu.manage' }),
    ).toThrow(ForbiddenException);
  });

  it('checks staff permissions for sessions', () => {
    const ctx = buildGraphqlContext({ user: staff });
    expect(() =>
      requireAccess(ctx, { scope: 'orders:read', permission: 'menu.manage' }),
    ).not.toThrow();
    expect(() =>
      requireAccess(ctx, { scope: 'menu:read', permission: 'orders.create' }),
    ).toThrow(ForbiddenException);
  });

  it('denies when the principal kind has no rule', () => {
    const ctx = buildGraphqlContext({ user: staff });
    expect(() => requireAccess(ctx, { scope: 'menu:read' })).toThrow(
      ForbiddenException,
    );
  });
});
