// Local fake of a delivery-aggregator / channel-manager partner API (#57).
// Implements the four outbound calls from docs/AGGREGATORS.md section 4.2 and
// can push signed order.created / order.cancelled / ping events to the POS.
// Standalone on purpose: depends only on node built-ins. See docs/AGGREGATORS.md.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo, Socket } from 'node:net';

/** Same format as `signAggregatorBody` in the POS (asserted by the spec). */
export function signBody(secret: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
}

export const PLATFORM_STATUSES = [
  'ACCEPTED',
  'REJECTED',
  'READY',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;

export type FailureMode = '500' | '401' | '429' | 'timeout';

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  signatureValid: boolean;
  replayed: boolean;
  failure?: FailureMode;
}

interface Failure {
  mode: FailureMode;
  times: number;
  path?: string;
}

export interface AggregatorMockOptions {
  apiKey: string;
  webhookSecret: string;
  port?: number;
}

export interface PushOptions {
  secret: string;
  /** Send the same body this many times (duplicate delivery). Default 1. */
  times?: number;
  badSignature?: boolean;
  /** Back-date the timestamp (replay / stale delivery). */
  ageSeconds?: number;
}

export class AggregatorMock {
  readonly calls: RecordedCall[] = [];
  menu: unknown = null;
  availability: Record<string, boolean> = {};
  /** Per platform outlet, for calls that name one (`outletId` in the body). */
  menuByOutlet: Record<string, unknown> = {};
  availabilityByOutlet: Record<string, Record<string, boolean>> = {};
  /** Per POS branch, for calls that name one (`branchId` in the body). */
  menuByBranch: Record<string, unknown> = {};
  availabilityByBranch: Record<string, Record<string, boolean>> = {};
  private readonly statuses = new Map<string, string[]>();
  private readonly idempotent = new Map<
    string,
    { status: number; body: string }
  >();
  private failures: Failure[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: AggregatorMockOptions) {}

  /** Statuses applied to an order, in arrival order. */
  orderStatuses(externalOrderId: string): string[] {
    return [...(this.statuses.get(externalOrderId) ?? [])];
  }

  /** Make the next `times` matching requests fail (default 1, any path). */
  failNext(mode: FailureMode, o: { times?: number; path?: string } = {}): void {
    this.failures.push({ mode, times: o.times ?? 1, path: o.path });
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) =>
      this.server!.listen(this.opts.port ?? 0, '127.0.0.1', r),
    );
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(() => r(undefined)));
  }

  /** Push one event to the POS webhook URL, signed like a real partner. */
  async push(
    url: string,
    event: unknown,
    o: PushOptions,
  ): Promise<{ status: number; body: string }[]> {
    const raw = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000) - (o.ageSeconds ?? 0));
    const sig = o.badSignature
      ? signBody(`${o.secret}-tampered`, ts, raw)
      : signBody(o.secret, ts, raw);
    const out: { status: number; body: string }[] = [];
    for (let i = 0; i < (o.times ?? 1); i++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OrderRestro-Timestamp': ts,
          'X-OrderRestro-Signature': sig,
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      out.push({ status: res.status, body: await res.text() });
    }
    return out;
  }

  /** Push events in order, or reversed to simulate out-of-order delivery. */
  async pushSequence(
    url: string,
    events: unknown[],
    o: PushOptions & { reverse?: boolean },
  ): Promise<{ status: number; body: string }[]> {
    const list = o.reverse ? [...events].reverse() : events;
    const out: { status: number; body: string }[] = [];
    for (const e of list) out.push(...(await this.push(url, e, o)));
    return out;
  }

  private takeFailure(path: string): FailureMode | undefined {
    const f = this.failures.find((x) => !x.path || x.path === path);
    if (!f) return undefined;
    if (--f.times <= 0) this.failures = this.failures.filter((x) => x !== f);
    return f.mode;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = (req.url ?? '/').split('?')[0];
    const method = req.method ?? 'GET';
    const header = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const ts = header('x-orderrestro-timestamp') ?? '';
    const sig = header('x-orderrestro-signature') ?? '';
    const expected = signBody(this.opts.webhookSecret, ts, raw);
    const signatureValid =
      sig.length === expected.length &&
      timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    const call: RecordedCall = {
      method,
      path,
      body,
      headers: req.headers,
      status: 0,
      signatureValid,
      replayed: false,
    };
    this.calls.push(call);
    const send = (
      status: number,
      payload: unknown,
      extra: Record<string, string> = {},
    ) => {
      call.status = status;
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(payload));
    };

    const failure = this.takeFailure(path);
    if (failure) {
      call.failure = failure;
      if (failure === 'timeout') return; // never answer; stop() drops it
      if (failure === '429')
        return send(429, { error: 'rate_limited' }, { 'Retry-After': '1' });
      if (failure === '401') return send(401, { error: 'unauthorized' });
      return send(500, { error: 'internal' });
    }
    if (header('authorization') !== `Bearer ${this.opts.apiKey}`) {
      return send(401, { error: 'unauthorized' });
    }
    if (path === '/v1/ping' && method === 'GET') return send(200, { ok: true });

    // Everything below mutates state, so it must be signed.
    if (!signatureValid) return send(401, { error: 'bad_signature' });
    const idem = header('idempotency-key');
    if (idem && this.idempotent.has(idem)) {
      call.replayed = true;
      const prev = this.idempotent.get(idem)!;
      return send(prev.status, JSON.parse(prev.body));
    }
    const done = (status: number, payload: unknown) => {
      if (idem && status < 300) {
        this.idempotent.set(idem, { status, body: JSON.stringify(payload) });
      }
      send(status, payload);
    };
    const b = (body ?? {}) as Record<string, unknown>;

    const m = /^\/v1\/orders\/([^/]+)\/status$/.exec(path);
    if (m && method === 'POST') {
      const status = String(b.status);
      if (!(PLATFORM_STATUSES as readonly string[]).includes(status)) {
        return done(400, { error: 'invalid_status' });
      }
      const id = decodeURIComponent(m[1]);
      this.statuses.set(id, [...(this.statuses.get(id) ?? []), status]);
      return done(200, { ok: true });
    }
    if (path === '/v1/items/availability' && method === 'POST') {
      if (!Array.isArray(b.items)) return done(400, { error: 'invalid_items' });
      const outlet = typeof b.outletId === 'string' ? b.outletId : null;
      const branch = typeof b.branchId === 'string' ? b.branchId : null;
      for (const i of b.items as {
        externalItemId: string;
        available: boolean;
      }[]) {
        this.availability[i.externalItemId] = !!i.available;
        if (outlet) {
          (this.availabilityByOutlet[outlet] ??= {})[i.externalItemId] =
            !!i.available;
        }
        if (branch) {
          (this.availabilityByBranch[branch] ??= {})[i.externalItemId] =
            !!i.available;
        }
      }
      return done(200, { ok: true });
    }
    if (path === '/v1/menu' && method === 'PUT') {
      this.menu = body;
      if (typeof b.outletId === 'string') this.menuByOutlet[b.outletId] = body;
      if (typeof b.branchId === 'string') this.menuByBranch[b.branchId] = body;
      return done(200, { ok: true, itemIds: {} });
    }
    return send(404, { error: 'not_found' });
  }
}
