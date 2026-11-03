// A local stand-in for the Razorpay QR Codes API, for tests and browser QA.
// It never talks to Razorpay and never moves money. Point the backend at it
// with RAZORPAY_API_BASE=http://localhost:4010 (honoured outside production).
//
//   pnpm exec ts-node test/razorpay-mock-server.ts      # listens on :4010
//
// Implements the subset the adapter uses:
//   POST /v1/payments/qr_codes          create a UPI QR
//   GET  /v1/payments/qr_codes?count=1  list (connection test)
//   GET  /v1/payments/qr_codes/:id      fetch one
// plus test controls (no auth):
//   GET  /__mock/qr_codes               every QR created, newest first
//   POST /__mock/qr_codes/:id/pay       guest pays: {"amount": paise}? (default: exact)
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_KEY_ID = 'rzp_test_mockkey000001';
export const MOCK_KEY_SECRET = 'mock-razorpay-secret-not-real';

export interface MockQr {
  id: string;
  entity: 'qr_code';
  type: 'upi_qr';
  usage: string;
  fixed_amount: boolean;
  status: 'active' | 'closed';
  close_reason: string | null;
  payment_amount: number;
  payments_amount_received: number;
  payments_count_received: number;
  description: string;
  notes: Record<string, string>;
  close_by: number;
  image_url: string;
  image_content: string;
  created_at: number;
}

export interface RazorpayMock {
  url: string;
  qrs: MockQr[];
  close(): Promise<void>;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (res: ServerResponse, status: number, description: string) =>
  send(res, status, {
    error: { code: 'BAD_REQUEST_ERROR', description, source: 'mock' },
  });

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

const id = () =>
  `qr_${randomBytes(10)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 14)}`;

function createQr(body: Record<string, unknown>): MockQr | string {
  const amount = body.payment_amount;
  if (body.type !== 'upi_qr') return 'type must be upi_qr';
  if (body.fixed_amount !== true) return 'only fixed_amount QRs are mocked';
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 100) {
    return 'payment_amount must be an integer number of paise >= 100';
  }
  const qrId = id();
  const rupees = (amount / 100).toFixed(2);
  return {
    id: qrId,
    entity: 'qr_code',
    type: 'upi_qr',
    usage: typeof body.usage === 'string' ? body.usage : 'single_use',
    fixed_amount: true,
    status: 'active',
    close_reason: null,
    payment_amount: amount,
    payments_amount_received: 0,
    payments_count_received: 0,
    description: typeof body.description === 'string' ? body.description : '',
    notes: (body.notes as Record<string, string>) ?? {},
    close_by: typeof body.close_by === 'number' ? body.close_by : 0,
    image_url: `https://rzp.io/i/mock-${qrId}`,
    image_content: `upi://pay?ver=01&mode=15&pa=rpy.mock@razorpay&pn=Nventra%20POS%20(mock)&tr=${qrId}&am=${rupees}&cu=INR`,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function startRazorpayMock(
  port = 0,
  keys = { id: MOCK_KEY_ID, secret: MOCK_KEY_SECRET },
): Promise<RazorpayMock> {
  const qrs: MockQr[] = [];
  const auth = `Basic ${Buffer.from(`${keys.id}:${keys.secret}`).toString('base64')}`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    if (path === '/__mock/qr_codes' && req.method === 'GET') {
      return send(res, 200, [...qrs].reverse());
    }
    const pay = /^\/__mock\/qr_codes\/([^/]+)\/pay$/.exec(path);
    if (pay && req.method === 'POST') {
      const qr = qrs.find((q) => q.id === pay[1]);
      if (!qr) return fail(res, 404, 'no such QR');
      const body = (await readJson(req)) as { amount?: number } | null;
      qr.payments_amount_received = body?.amount ?? qr.payment_amount;
      qr.payments_count_received = 1;
      qr.status = 'closed';
      qr.close_reason = 'paid';
      return send(res, 200, qr);
    }
    if (req.headers.authorization !== auth) {
      return send(res, 401, {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'Authentication failed',
        },
      });
    }
    if (path === '/v1/payments/qr_codes' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return fail(res, 400, 'bad JSON');
      const qr = createQr(body as Record<string, unknown>);
      if (typeof qr === 'string') return fail(res, 400, qr);
      qrs.push(qr);
      return send(res, 200, qr);
    }
    if (path === '/v1/payments/qr_codes' && req.method === 'GET') {
      const count = Number(url.searchParams.get('count') ?? 10);
      const items = [...qrs].reverse().slice(0, count);
      return send(res, 200, {
        entity: 'collection',
        count: items.length,
        items,
      });
    }
    const one = /^\/v1\/payments\/qr_codes\/([^/]+)$/.exec(path);
    if (one && req.method === 'GET') {
      const qr = qrs.find((q) => q.id === one[1]);
      return qr
        ? send(res, 200, qr)
        : fail(res, 404, 'The id provided does not exist');
    }
    return fail(res, 404, 'not mocked');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => fail(res, 500, 'mock error'));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        qrs,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.RAZORPAY_MOCK_PORT ?? 4010);
  void startRazorpayMock(port).then((m) => {
    process.stdout.write(`razorpay mock listening on ${m.url}\n`);
  });
}
