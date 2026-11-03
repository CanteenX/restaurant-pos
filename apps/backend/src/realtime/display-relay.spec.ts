import { RealtimeGateway } from './realtime.gateway';

// Customer display relay: a paired display only ever receives what a till in
// the SAME branch published under the SAME code.
function makeGateway() {
  const emitted: { rooms: string[]; event: string; payload: unknown }[] = [];
  const gw = new RealtimeGateway(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  gw.server = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: unknown) =>
        emitted.push({ rooms: ([] as string[]).concat(rooms), event, payload }),
    }),
  } as never;
  return { gw, emitted };
}
function makeClient(branchId: string | undefined) {
  const joined: string[] = [];
  const client = {
    data: { branchId },
    join: (r: string) => Promise.resolve(void joined.push(r)),
  };
  return { client: client as never, joined };
}

describe('customer display relay', () => {
  it('joins a room scoped to the socket branch and code', async () => {
    const { gw } = makeGateway();
    const a = makeClient('branch-a');
    await gw.onDisplayJoin(a.client, { code: 'abc234' });
    expect(a.joined).toEqual(['display:branch-a:ABC234']);
  });

  it('rejects malformed codes and sockets without a branch', async () => {
    const { gw } = makeGateway();
    const a = makeClient('branch-a');
    expect(await gw.onDisplayJoin(a.client, { code: 'bad' })).toEqual({
      ok: false,
    });
    const none = makeClient(undefined);
    expect(await gw.onDisplayJoin(none.client, { code: 'ABC234' })).toEqual({
      ok: false,
    });
    expect(a.joined).toEqual([]);
  });

  it('publishes only to the sender branch room, never another branch', () => {
    const { gw, emitted } = makeGateway();
    const till = makeClient('branch-a');
    const state = { kind: 'idle' as const };
    expect(gw.onDisplayPublish(till.client, { code: 'ABC234', state })).toEqual(
      { ok: true },
    );
    expect(emitted).toEqual([
      {
        rooms: ['display:branch-a:ABC234'],
        event: 'display.state',
        payload: state,
      },
    ]);
  });

  it('drops invalid states', () => {
    const { gw, emitted } = makeGateway();
    const till = makeClient('branch-a');
    expect(
      gw.onDisplayPublish(till.client, {
        code: 'ABC234',
        state: { kind: 'nope' },
      }),
    ).toEqual({ ok: false });
    expect(emitted).toEqual([]);
  });
});
