import { displayStateSchema } from '@nventra/types';
import { RealtimeGateway } from './realtime.gateway';

// Customer display relay: a paired display only ever receives what a till in
// the SAME branch published under the SAME code, a till must hold
// orders.create to publish, and a code belongs to the till that issued it.
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

let nextId = 0;
function makeClient(
  branchId: string | undefined,
  permissions: string[] = ['orders.create'],
) {
  const joined: string[] = [];
  const client = {
    id: `sock-${++nextId}`,
    data: { branchId, permissions },
    join: (r: string) => Promise.resolve(void joined.push(r)),
  };
  return { client: client as never, joined, id: client.id };
}

const idle = { kind: 'idle' as const };

describe('customer display relay', () => {
  it('joins a room scoped to the socket branch and an issued code', async () => {
    const { gw } = makeGateway();
    const till = makeClient('branch-a');
    gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle });
    const display = makeClient('branch-a', []);
    expect(await gw.onDisplayJoin(display.client, { code: 'abc234' })).toEqual({
      ok: true,
    });
    expect(display.joined).toEqual(['display:branch-a:ABC234']);
  });

  it('rejects joining a code no till in this branch has issued', async () => {
    const { gw } = makeGateway();
    const till = makeClient('branch-b');
    gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle });
    const display = makeClient('branch-a', []);
    expect(await gw.onDisplayJoin(display.client, { code: 'ABC234' })).toEqual({
      ok: false,
    });
    expect(await gw.onDisplayJoin(display.client, { code: 'XYZ789' })).toEqual({
      ok: false,
    });
    expect(display.joined).toEqual([]);
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
    expect(
      gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle }),
    ).toEqual({ ok: true });
    expect(emitted).toEqual([
      {
        rooms: ['display:branch-a:ABC234'],
        event: 'display.state',
        payload: idle,
      },
    ]);
  });

  it('denies publishing without orders.create (e.g. a kitchen account)', () => {
    const { gw, emitted } = makeGateway();
    const kitchen = makeClient('branch-a', ['kds.manage', 'orders.accept']);
    const paid = { kind: 'paid' as const, total: 100 };
    expect(
      gw.onDisplayPublish(kitchen.client, { code: 'ABC234', state: paid }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(emitted).toEqual([]);
  });

  it("denies publishing into another till's code", () => {
    const { gw, emitted } = makeGateway();
    const till = makeClient('branch-a');
    const rogue = makeClient('branch-a');
    gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle });
    const paid = { kind: 'paid' as const, total: 100 };
    expect(
      gw.onDisplayPublish(rogue.client, { code: 'ABC234', state: paid }),
    ).toEqual({ ok: false, error: 'code-in-use' });
    expect(emitted).toHaveLength(1);
  });

  it('frees a code when its till disconnects so a reconnect can reclaim it', async () => {
    const { gw } = makeGateway();
    const till = makeClient('branch-a');
    gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle });
    gw.handleDisconnect(till.client);
    const display = makeClient('branch-a', []);
    expect(await gw.onDisplayJoin(display.client, { code: 'ABC234' })).toEqual({
      ok: false,
    });
    const again = makeClient('branch-a');
    expect(
      gw.onDisplayPublish(again.client, { code: 'ABC234', state: idle }),
    ).toEqual({ ok: true });
  });

  it('rate-limits display events per socket', () => {
    const { gw, emitted } = makeGateway();
    const till = makeClient('branch-a');
    const results = Array.from({ length: 60 }, () =>
      gw.onDisplayPublish(till.client, { code: 'ABC234', state: idle }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(40);
    expect(results.at(-1)).toEqual({ ok: false, error: 'rate-limited' });
    expect(emitted).toHaveLength(40);
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

  it('rejects a UPI state whose uri is not a upi://pay link', () => {
    const { gw, emitted } = makeGateway();
    const till = makeClient('branch-a');
    for (const uri of [
      'https://evil.example/pay',
      'javascript:alert(1)',
      'upi://mandate?pa=x@y',
      'upi://pay?pa=x@y\n<script>',
    ]) {
      const state = { kind: 'upi', total: 10, uri, payee: 'X' };
      expect(
        gw.onDisplayPublish(till.client, { code: 'ABC234', state }),
      ).toEqual({ ok: false });
    }
    expect(emitted).toEqual([]);
  });
});

describe('displayStateSchema upi uri', () => {
  it('accepts NPCI links from the till and the Razorpay QR', () => {
    for (const uri of [
      'upi://pay?pa=shop%40okicici&pn=Caf%C3%A9%20One&am=250.50&cu=INR',
      'upi://pay?ver=01&mode=15&pa=rpy.qrnventra@icici&pn=Nventra&am=250.50&cu=INR',
      'UPI://PAY?pa=a@b',
    ]) {
      const r = displayStateSchema.safeParse({
        kind: 'upi',
        total: 1,
        uri,
        payee: 'x',
      });
      expect(r.success).toBe(true);
    }
  });
});
