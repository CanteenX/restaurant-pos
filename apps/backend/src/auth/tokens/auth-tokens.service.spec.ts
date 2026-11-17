import { AuthTokensService } from './auth-tokens.service';
import { hashSecret, parseLinkToken, toLinkToken } from './auth-token';

const NOW = new Date('2026-11-17T10:00:00Z').getTime();
const MIN = 60_000;

interface Row {
  id: string;
  userId: string;
  restaurantId: string;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdById: string | null;
}

/** A tiny in-memory stand-in for prisma.authToken (enough for these paths). */
function fakePrisma() {
  let rows: Row[] = [];
  let seq = 0;
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const val = r[k as keyof Row];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const op = v as { gt?: Date; lt?: Date; not?: unknown };
        if (op.gt) return val instanceof Date && val > op.gt;
        if (op.lt) return val instanceof Date && val < op.lt;
        if ('not' in op) return val !== op.not;
      }
      return val === v;
    });
  const authToken = {
    create: jest.fn(({ data }: { data: Omit<Row, 'id' | 'usedAt'> }) => {
      const row: Row = {
        usedAt: null,
        ...data,
        id: `tok${++seq}abcdefgh`,
      };
      rows = [...rows, row];
      return Promise.resolve(row);
    }),
    findUnique: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
    ),
    findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }) => {
        let count = 0;
        rows = rows.map((r) => {
          if (!matches(r, where)) return r;
          count++;
          return { ...r, ...data };
        });
        return Promise.resolve({ count });
      },
    ),
    deleteMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, where));
      return Promise.resolve({ count: before - rows.length });
    }),
  };
  const prisma = {
    authToken,
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  return { prisma, rows: () => rows };
}

function setup() {
  const db = fakePrisma();
  const svc = new AuthTokensService(db.prisma as never);
  return { svc, ...db };
}

const issueReset = (svc: AuthTokensService, userId = 'u1') =>
  svc.issue({
    userId,
    restaurantId: 'r1',
    purpose: 'PASSWORD_RESET',
    ttlMs: 30 * MIN,
  });

describe('AuthTokensService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => jest.useRealTimers());

  it('issues <id>.<secret> and stores only the secret hash', async () => {
    const { svc, rows } = setup();
    const { token, expiresAt } = await issueReset(svc);
    const parsed = parseLinkToken(token);
    expect(parsed).not.toBeNull();
    const [row] = rows();
    expect(row.id).toBe(parsed?.id);
    expect(row.tokenHash).toBe(hashSecret(parsed!.secret));
    expect(JSON.stringify(row)).not.toContain(parsed!.secret);
    expect(expiresAt.getTime()).toBe(NOW + 30 * MIN);
  });

  it('a new token invalidates every outstanding token of that user', async () => {
    const { svc, rows } = setup();
    const first = await issueReset(svc);
    await issueReset(svc, 'other-user');
    const second = await issueReset(svc);
    expect(rows().filter((r) => r.userId === 'u1')).toHaveLength(1);
    expect(rows().filter((r) => r.userId === 'other-user')).toHaveLength(1);
    expect(await svc.redeem(first.token, 'PASSWORD_RESET', () => 'x')).toBe(
      null,
    );
    expect(await svc.redeem(second.token, 'PASSWORD_RESET', () => 'ok')).toBe(
      'ok',
    );
  });

  it('redeems once; reuse is rejected and apply is not run again', async () => {
    const { svc } = setup();
    const { token } = await issueReset(svc);
    const apply = jest.fn().mockResolvedValue('done');
    expect(await svc.redeem(token, 'PASSWORD_RESET', apply)).toBe('done');
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'u1', restaurantId: 'r1' }),
    );
    expect(await svc.redeem(token, 'PASSWORD_RESET', apply)).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('using a token invalidates the user’s other outstanding tokens', async () => {
    const { svc, rows } = setup();
    const reset = await issueReset(svc);
    // An invite issued by an admin after the reset request.
    await svc.issue({
      userId: 'u1',
      restaurantId: 'r1',
      purpose: 'STAFF_INVITE',
      ttlMs: 72 * 60 * MIN,
    });
    expect(await svc.redeem(reset.token, 'PASSWORD_RESET', () => 1)).toBeNull();
    const invite = rows().find((r) => r.purpose === 'STAFF_INVITE')!;
    expect(invite).toBeDefined();
    const other = await issueReset(svc, 'u2');
    const again = await issueReset(svc);
    await svc.redeem(again.token, 'PASSWORD_RESET', () => 1);
    expect(rows().filter((r) => r.userId === 'u1' && !r.usedAt)).toEqual([]);
    expect(
      await svc.redeem(other.token, 'PASSWORD_RESET', () => 'still ok'),
    ).toBe('still ok');
  });

  it('rejects an expired token', async () => {
    const { svc } = setup();
    const { token } = await issueReset(svc);
    jest.setSystemTime(NOW + 30 * MIN + 1);
    expect(await svc.redeem(token, 'PASSWORD_RESET', () => 1)).toBeNull();
  });

  it('rejects a token used for the wrong purpose', async () => {
    const { svc } = setup();
    const { token } = await issueReset(svc);
    expect(await svc.redeem(token, 'STAFF_INVITE', () => 1)).toBeNull();
  });

  it('rejects a wrong secret, an unknown id and garbage', async () => {
    const { svc } = setup();
    const { token } = await issueReset(svc);
    const { id } = parseLinkToken(token)!;
    const wrong = toLinkToken(id, 'A'.repeat(43));
    expect(await svc.redeem(wrong, 'PASSWORD_RESET', () => 1)).toBeNull();
    expect(
      await svc.redeem(
        toLinkToken('unknownid', 'A'.repeat(43)),
        'PASSWORD_RESET',
        () => 1,
      ),
    ).toBeNull();
    expect(await svc.redeem('garbage', 'PASSWORD_RESET', () => 1)).toBeNull();
    // The real token still works after the failed attempts.
    expect(await svc.redeem(token, 'PASSWORD_RESET', () => 'ok')).toBe('ok');
  });

  it('peek validates without consuming', async () => {
    const { svc } = setup();
    const { token } = await issueReset(svc);
    expect(await svc.peek(token, 'PASSWORD_RESET')).toEqual(
      expect.objectContaining({ userId: 'u1' }),
    );
    expect(await svc.peek(token, 'STAFF_INVITE')).toBeNull();
    expect(await svc.redeem(token, 'PASSWORD_RESET', () => 'ok')).toBe('ok');
    expect(await svc.peek(token, 'PASSWORD_RESET')).toBeNull();
  });

  it('revokeOutstanding drops only the outstanding tokens of one purpose', async () => {
    const { svc, rows } = setup();
    await issueReset(svc);
    const n = await svc.revokeOutstanding('u1', 'STAFF_INVITE');
    expect(n).toBe(0);
    expect(await svc.revokeOutstanding('u1', 'PASSWORD_RESET')).toBe(1);
    expect(rows()).toEqual([]);
  });
});
