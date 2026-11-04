import { RealtimeGateway } from './realtime.gateway';

// handleConnection must fill client.data from the verified session: the
// display relay trusts exactly these fields.
function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    restaurantId: 'r1',
    isActive: true,
    tokenVersion: 0,
    role: {
      permissions: [
        { permission: { key: 'orders.create' } },
        { permission: { key: 'kds.manage' } },
      ],
    },
    permissionOverrides: [],
    ...overrides,
  };
}

async function connect(user: ReturnType<typeof makeUser>) {
  const gw = new RealtimeGateway(
    { verify: () => ({ sub: 'u1', tv: 0 }) } as never,
    { user: { findUnique: () => Promise.resolve(user) } } as never,
    { assertAccess: () => Promise.resolve() } as never,
    { get: () => undefined } as never,
  );
  const client = {
    id: 's1',
    data: {} as Record<string, unknown>,
    handshake: {
      headers: { cookie: 'nventra_session=tok' },
      query: { branchId: 'b1' },
    },
    join: () => Promise.resolve(),
    disconnect: jest.fn(),
  };
  await gw.handleConnection(client as never);
  return client;
}

describe('RealtimeGateway.handleConnection', () => {
  it('stores branch, user and effective permissions on the socket', async () => {
    const client = await connect(makeUser());
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.data).toEqual({
      branchId: 'b1',
      userId: 'u1',
      permissions: ['orders.create', 'kds.manage'],
    });
  });

  it('applies a live DENY override, so the socket cannot publish', async () => {
    const client = await connect(
      makeUser({
        permissionOverrides: [
          {
            effect: 'DENY',
            expiresAt: null,
            permission: { key: 'orders.create' },
          },
        ],
      }),
    );
    expect(client.data.permissions).toEqual(['kds.manage']);
  });
});
