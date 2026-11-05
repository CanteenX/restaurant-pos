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

// Regression (#146 review): Nest binds message handlers and socket.io sends
// CONNECT before handleConnection resolves, so a till's publish from its
// `connect` handler lands while the session lookup is still pending.
function pendingConnect(user: ReturnType<typeof makeUser> | null) {
  let resolveUser!: (u: unknown) => void;
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  const gw = new RealtimeGateway(
    { verify: () => ({ sub: 'u1', tv: 0 }) } as never,
    {
      user: {
        findUnique: () => new Promise((r) => (resolveUser = r)),
      },
    } as never,
    { assertAccess: () => Promise.resolve() } as never,
    { get: () => undefined } as never,
  );
  gw.server = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) =>
        emitted.push({ room, event, payload }),
    }),
  } as never;
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
  const connected = gw.handleConnection(client as never);
  return { gw, client, emitted, connected, finish: () => resolveUser(user) };
}

describe('RealtimeGateway display events during authentication', () => {
  const state = { kind: 'idle' as const };

  it('waits for auth, then accepts a publish sent right after connect', async () => {
    const p = pendingConnect(makeUser());
    const ack = p.gw.onDisplayPublish(p.client as never, {
      code: 'ABC234',
      state,
    });
    p.finish();
    expect(await ack).toEqual({ ok: true });
    await p.connected;
    expect(p.emitted).toEqual([
      { room: 'display:b1:ABC234', event: 'display.state', payload: state },
    ]);
  });

  it('still forbids an early publish when the session turns out invalid', async () => {
    const p = pendingConnect(null);
    const ack = p.gw.onDisplayPublish(p.client as never, {
      code: 'ABC234',
      state,
    });
    p.finish();
    expect(await ack).toEqual({ ok: false, error: 'forbidden' });
    await p.connected;
    expect(p.client.disconnect).toHaveBeenCalledWith(true);
    expect(p.emitted).toEqual([]);
  });
});
