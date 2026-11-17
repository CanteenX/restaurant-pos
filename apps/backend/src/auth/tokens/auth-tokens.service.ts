import { Injectable } from '@nestjs/common';
import type { AuthToken, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  hashSecret,
  newTokenSecret,
  parseLinkToken,
  secretMatches,
  toLinkToken,
  type AuthTokenPurpose,
} from './auth-token';

/** Expired rows older than this are swept whenever a new token is issued. */
const SWEEP_AFTER_MS = 24 * 60 * 60_000;

export interface IssueTokenInput {
  userId: string;
  restaurantId: string;
  purpose: AuthTokenPurpose;
  ttlMs: number;
  createdById?: string;
}

/** What a valid token stands for. */
export interface TokenClaim {
  userId: string;
  restaurantId: string;
  expiresAt: Date;
  createdById: string | null;
}

/**
 * Issues and redeems single-use link tokens (see auth-token.ts). Rules:
 *  - a new token invalidates the user's outstanding tokens of the same
 *    purpose (atomically: transaction + user row lock);
 *  - a token works once, before it expires, for its own purpose only;
 *  - redeeming invalidates the user's other outstanding tokens too.
 * The token itself is returned to the caller once and never stored or logged.
 */
@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    input: IssueTokenInput,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = Date.now();
    const secret = newTokenSecret();
    const expiresAt = new Date(now + input.ttlMs);
    // One transaction, serialised per user by a row lock: two parallel
    // requests can never both leave a live link. Only the SAME purpose is
    // replaced, so a reset request cannot revoke a staff invite (#223).
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
      await tx.authToken.deleteMany({
        where: { userId: input.userId, purpose: input.purpose, usedAt: null },
      });
      await tx.authToken.deleteMany({
        where: { expiresAt: { lt: new Date(now - SWEEP_AFTER_MS) } },
      });
      return tx.authToken.create({
        data: {
          userId: input.userId,
          restaurantId: input.restaurantId,
          purpose: input.purpose,
          tokenHash: hashSecret(secret),
          expiresAt,
          createdById: input.createdById ?? null,
        },
      });
    });
    return { token: toLinkToken(row.id, secret), expiresAt };
  }

  /** Checks a token without using it up (e.g. to show the invite page). */
  async peek(
    token: string,
    purpose: AuthTokenPurpose,
  ): Promise<TokenClaim | null> {
    const parsed = parseLinkToken(token);
    if (!parsed) return null;
    const row = await this.prisma.authToken.findUnique({
      where: { id: parsed.id },
    });
    return this.validClaim(row, parsed.secret, purpose);
  }

  /**
   * Uses the token up and runs `apply` in the same transaction. Returns null
   * (and runs nothing) for an unknown, wrong, used, expired or other-purpose
   * token. If `apply` throws, the transaction rolls back and the token stays
   * usable.
   */
  async redeem<T>(
    token: string,
    purpose: AuthTokenPurpose,
    apply: (tx: Prisma.TransactionClient, claim: TokenClaim) => T | Promise<T>,
  ): Promise<T | null> {
    const parsed = parseLinkToken(token);
    if (!parsed) return null;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.authToken.findUnique({ where: { id: parsed.id } });
      const claim = this.validClaim(row, parsed.secret, purpose);
      if (!claim) return null;
      // Atomic claim: of two concurrent redeems only one sees count 1.
      const { count } = await tx.authToken.updateMany({
        where: { id: parsed.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count !== 1) return null;
      const result = await apply(tx, claim);
      await tx.authToken.deleteMany({
        where: { userId: claim.userId, usedAt: null },
      });
      return result;
    });
  }

  /** Drops a user's outstanding tokens of one purpose (invite revoke). */
  async revokeOutstanding(
    userId: string,
    purpose: AuthTokenPurpose,
  ): Promise<number> {
    const { count } = await this.prisma.authToken.deleteMany({
      where: { userId, purpose, usedAt: null },
    });
    return count;
  }

  private validClaim(
    row: AuthToken | null,
    secret: string,
    purpose: AuthTokenPurpose,
  ): TokenClaim | null {
    // Hash even when the row is missing, so both paths cost the same.
    const matches = secretMatches(secret, row?.tokenHash ?? '0'.repeat(64));
    if (!row || !matches) return null;
    if (row.purpose !== purpose || row.usedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: row.userId,
      restaurantId: row.restaurantId,
      expiresAt: row.expiresAt,
      createdById: row.createdById,
    };
  }
}
