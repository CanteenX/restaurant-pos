import { HttpException, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcrypt';
import type { Prisma, PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { openPortalDatabase } from './portal-database.js';
import { portalDigest, portalToken, type readPortalConfig } from './portal-identity-policy.js';

export type PortalPrincipal = { accountId: string; businessId: string; email: string };
type AccountCredential = { id: string; passwordHash: string };

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

  private sessionToken() {
    const token = portalToken();
    return { token, digest: portalDigest(this.key, 'session', token) };
  }

  async activate(code: string, password: string, peer: string) {
    await this.limit('activation', peer, code);
    const verifier = await hash(password, 12);
    const { token, digest } = this.sessionToken();
    const [principal] = await this.db.$queryRaw<PortalPrincipal[]>`
      SELECT * FROM control.portal_activate(${this.activationDigest(code)},${verifier},${digest})`;
    if (!principal) throw new UnauthorizedException();
    return { token, principal };
  }

  async login(email: string, password: string, peer: string) {
    await this.limit('login', peer, email);
    const [account] = await this.db.$queryRaw<AccountCredential[]>`
      SELECT * FROM control.portal_login_verifier(${email})`;
    const valid = await compare(password, account?.passwordHash ?? this.dummyHash);
    if (!valid || !account) throw new UnauthorizedException();
    const { token, digest } = this.sessionToken();
    const [principal] = await this.db.$queryRaw<PortalPrincipal[]>`
      SELECT * FROM control.portal_open_session(${account.id}::uuid,${account.passwordHash},${digest})`;
    if (!principal) throw new UnauthorizedException();
    return { token, principal };
  }

  withSession<T>(token: string, use: (tx: Prisma.TransactionClient, principal: PortalPrincipal) => Promise<T>) {
    const digest = portalDigest(this.key, 'session', token);
    return this.db.$transaction(async (tx) => {
      const [principal] = await tx.$queryRaw<PortalPrincipal[]>`SELECT * FROM control.portal_lock_session(${digest})`;
      if (!principal) throw new UnauthorizedException();
      await tx.$queryRaw`SELECT pg_catalog.set_config('control.portal_business_id', ${principal.businessId}, true),
        pg_catalog.set_config('control.portal_account_id', ${principal.accountId}, true)`;
      return use(tx, principal);
    });
  }

  async logout(token: string) {
    await this.db.$executeRaw`SELECT control.portal_logout(${portalDigest(this.key, 'session', token)})`;
  }
}
