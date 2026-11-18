import { HttpException, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcrypt';
import type { Prisma, PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { openPortalDatabase } from './portal-database.js';
import { portalDigest, portalToken, type readPortalConfig } from './portal-identity-policy.js';

export type PortalPrincipal = { accountId: string; businessId: string; email: string };
type AccountCredential = { id: string; passwordHash: string | null; status: string };

export class PortalAuth {
  private constructor(private readonly db: PrismaClient, private readonly key: string,
    readonly origin: string, private readonly dummyHash: string) {}

  static async create(config: NonNullable<ReturnType<typeof readPortalConfig>>) {
    const dummyHash = await hash(portalToken(), 12);
    return new PortalAuth(await openPortalDatabase(config.url), config.key, config.origin, dummyHash);
  }

  onModuleDestroy() { return this.db.$disconnect(); }

  activationDigest(code: string) { return portalDigest(this.key, 'activation', code); }

  private async limit(stage: 'activation' | 'login', peer: string, identity: string) {
    for (const [kind, value, maximum] of [['peer', peer, 24], ['identity', identity, 8]] as const) {
      const bucket = portalDigest(this.key, 'rate:' + stage + ':' + kind, value);
      const rows = await this.db.$queryRaw<{ attempts: number }[]>`
        INSERT INTO control.portal_auth_limit AS b (bucket, attempts, expires_at)
        VALUES (${bucket}, 1, now() + interval '10 minutes')
        ON CONFLICT (bucket) DO UPDATE SET
          attempts = CASE WHEN b.expires_at <= now() THEN 1 ELSE b.attempts + 1 END,
          expires_at = CASE WHEN b.expires_at <= now() THEN EXCLUDED.expires_at ELSE b.expires_at END
        WHERE b.expires_at <= now() OR b.attempts < ${maximum} RETURNING attempts`;
      if (!rows.length) throw new HttpException('Too many attempts', 429);
      if (kind === 'peer') await this.db.$executeRaw`
        DELETE FROM control.portal_auth_limit WHERE expires_at <= now() AND bucket IN
        (SELECT bucket FROM control.portal_auth_limit WHERE expires_at <= now() LIMIT 64)`;
    }
  }

  private async newSession(tx: Prisma.TransactionClient, principal: PortalPrincipal) {
    const token = portalToken(), digest = portalDigest(this.key, 'session', token);
    await tx.$executeRaw`INSERT INTO control.portal_session(digest, account_id, expires_at)
      VALUES (${digest}, ${principal.accountId}::uuid, clock_timestamp() + interval '8 hours')`;
    return { token, principal };
  }

  async activate(code: string, password: string, peer: string) {
    await this.limit('activation', peer, code);
    const verifier = await hash(password, 12);
    return this.db.$transaction(async (tx) => {
      const [principal] = await tx.$queryRaw<PortalPrincipal[]>`
        UPDATE control.portal_account SET status = 'active', password_hash = ${verifier},
          activation_digest = NULL, activation_expires_at = NULL
        WHERE activation_digest = ${this.activationDigest(code)} AND status = 'pending'
          AND activation_expires_at > clock_timestamp()
        RETURNING id AS "accountId", business_id AS "businessId", email`;
      if (!principal) throw new UnauthorizedException();
      return this.newSession(tx, principal);
    });
  }

  async login(email: string, password: string, peer: string) {
    await this.limit('login', peer, email);
    const [account] = await this.db.$queryRaw<AccountCredential[]>`
      SELECT id, password_hash AS "passwordHash", status FROM control.portal_account WHERE email = ${email}`;
    const valid = await compare(password, account?.passwordHash ?? this.dummyHash);
    if (!valid || account?.status !== 'active' || !account.passwordHash) throw new UnauthorizedException();

    return this.db.$transaction(async (tx) => {
      const [principal] = await tx.$queryRaw<PortalPrincipal[]>`SELECT id AS "accountId", business_id AS "businessId", email
        FROM control.portal_account WHERE id = ${account.id}::uuid AND status = 'active'
          AND password_hash = ${account.passwordHash} FOR SHARE`;
      if (!principal) throw new UnauthorizedException();
      return this.newSession(tx, principal);
    });
  }

  withSession<T>(token: string, use: (tx: Prisma.TransactionClient, principal: PortalPrincipal) => Promise<T>) {
    const digest = portalDigest(this.key, 'session', token);
    return this.db.$transaction(async (tx) => {
      const [session] = await tx.$queryRaw<{ id: string }[]>`
        SELECT account_id AS id FROM control.portal_session WHERE digest = ${digest}`;
      if (!session) throw new UnauthorizedException();
      await tx.$queryRaw`SELECT id FROM control.portal_account WHERE id = ${session.id}::uuid FOR SHARE`;
      const [principal] = await tx.$queryRaw<PortalPrincipal[]>`SELECT a.id AS "accountId", a.business_id AS "businessId", a.email
        FROM control.portal_session s JOIN control.portal_account a ON a.id = s.account_id
        WHERE s.digest = ${digest} AND a.id = ${session.id}::uuid AND a.status = 'active'
          AND s.expires_at > clock_timestamp()`;
      if (!principal) throw new UnauthorizedException();
      await tx.$queryRaw`SELECT pg_catalog.set_config('control.portal_business_id', ${principal.businessId}, true)`;
      return use(tx, principal);
    });
  }

  async logout(token: string) {
    await this.db.$executeRaw`DELETE FROM control.portal_session WHERE digest = ${portalDigest(this.key, 'session', token)}`;
  }
}
