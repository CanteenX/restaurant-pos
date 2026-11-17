import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newPasswordSchema } from '@nventra/types';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { KeyRateLimiter, envLimit } from '../common/guards/key-rate-limiter';
import { EmailService } from '../modules/email/email.service';
import { EmailTemplatesService } from '../modules/email/templates/email-templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';
import { emailAccountQuery, normaliseEmail } from './account-lookup';
import { AuthTokensService } from './tokens/auth-tokens.service';
import { authLink, publicBaseUrl } from './tokens/public-url';

interface AccountRecipient {
  id: string;
  restaurantId: string;
  name: string;
  email: string | null;
}

export const PASSWORD_RESET_TTL_MS = 30 * 60_000;
const PASSWORD_RESET_EXPIRES_IN = '30 minutes';
/** Per 15 minutes; PASSWORD_RESET_IP_LIMIT overrides it. */
export const RESET_PER_IP_LIMIT = 5;
const RESET_IP_WINDOW_MS = 15 * 60_000;
export const RESET_PER_ACCOUNT_LIMIT = 3;
const RESET_ACCOUNT_WINDOW_MS = 60 * 60_000;
const BCRYPT_COST = 12;

const OK = { ok: true } as const;
const INVALID_LINK =
  'This reset link is invalid or has expired. Ask for a new one.';
const WEAK_PASSWORD = 'The new password must be 8 to 200 characters long.';

/**
 * "Forgot password" by email (#224).
 *
 * The request endpoint gives the same answer, in about the same time, for
 * every address: rate limits run first, then the reply goes out and the
 * lookup, token and SMTP work happen afterwards in the background. Per IP,
 * too many requests get a 429 (it is the same for every address); per
 * account the limit is silent, so it cannot be used to probe addresses.
 *
 * Completing a reset sets the password, bumps tokenVersion (every session
 * ends) and is audited. Two-factor stays on: an emailed link proves only
 * control of the inbox, so it must not also remove the second factor.
 *
 * Never logged: tokens, links, recipient addresses.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly ipLimiter = new KeyRateLimiter(RESET_IP_WINDOW_MS);
  private readonly accountLimiter = new KeyRateLimiter(RESET_ACCOUNT_WINDOW_MS);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokensService,
    private readonly templates: EmailTemplatesService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private get baseUrl(): string | null {
    return publicBaseUrl(this.config.get<string>('PUBLIC_URL'));
  }

  /** Whether the web app should offer "Forgot password?" at all. */
  isAvailable(): boolean {
    return this.email.isConfigured() && this.baseUrl !== null;
  }

  request(rawEmail: string, ip: string): Promise<typeof OK> {
    // A thrown 429 becomes a rejected promise.
    return new Promise((resolve) => resolve(this.accept(rawEmail, ip)));
  }

  /** Limits, then queues delivery; never waits for the lookup or SMTP. */
  private accept(rawEmail: string, ip: string): typeof OK {
    const email = normaliseEmail(rawEmail);
    const ipWait = this.ipLimiter.hit(
      `ip:${ip}`,
      envLimit('PASSWORD_RESET_IP_LIMIT', RESET_PER_IP_LIMIT),
    );
    if (ipWait > 0) {
      throw new HttpException(
        `Too many reset requests. Try again in ${Math.ceil(ipWait / 60)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!this.isAvailable()) return OK;
    const accountKey = createHash('sha256').update(email).digest('hex');
    if (this.accountLimiter.hit(accountKey, RESET_PER_ACCOUNT_LIMIT) > 0) {
      return OK;
    }
    this.track(this.deliver(email));
    return OK;
  }

  /** Resolves once every background delivery has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async confirm(token: string, password: string): Promise<typeof OK> {
    if (!newPasswordSchema.safeParse(password).success) {
      throw new BadRequestException(WEAK_PASSWORD);
    }
    // Hashed before the transaction so it stays short.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const userId = await this.tokens.redeem(
      token,
      'PASSWORD_RESET',
      async (tx, claim) => {
        const user = await tx.user.findFirst({
          where: {
            id: claim.userId,
            restaurantId: claim.restaurantId,
            isActive: true,
          },
          select: { id: true },
        });
        // Throwing rolls the claim back; the generic text reveals nothing.
        if (!user) throw new BadRequestException(INVALID_LINK);
        // Password, tokenVersion (every session ends) and the token claim
        // commit together or not at all (#224 review).
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, tokenVersion: { increment: 1 } },
        });
        return user.id;
      },
    );
    if (!userId) throw new BadRequestException(INVALID_LINK);
    this.sessions.disconnect(userId);
    await this.audit.record({
      userId,
      action: 'auth.password_reset.completed',
      entity: 'User',
      entityId: userId,
    });
    return OK;
  }

  private track(job: Promise<void>) {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /**
   * One link for exactly the account login resolves for this address (the
   * shared resolver, account-lookup.ts). The email is rendered for that
   * account's restaurant, so it says which restaurant the link is for.
   */
  private async deliver(email: string): Promise<void> {
    const base = this.baseUrl;
    if (!base) return;
    let user: AccountRecipient | null = null;
    try {
      user = await this.prisma.user.findFirst({
        ...emailAccountQuery(email),
        select: { id: true, restaurantId: true, name: true, email: true },
      });
    } catch (err) {
      this.logFailure(err);
    }
    if (user) await this.deliverTo(user, base);
  }

  private async deliverTo(user: AccountRecipient, base: string) {
    try {
      if (!user.email) return;
      const branchId = await this.branchFor(user.id, user.restaurantId);
      if (!branchId) return;
      const { token } = await this.tokens.issue({
        userId: user.id,
        restaurantId: user.restaurantId,
        purpose: 'PASSWORD_RESET',
        ttlMs: PASSWORD_RESET_TTL_MS,
      });
      const compose = await this.templates.forBranchAlways(
        branchId,
        'PASSWORD_RESET',
      );
      const mail = compose({
        'user.name': user.name,
        'reset.url': authLink(base, '/reset-password', token),
        'reset.expiresIn': PASSWORD_RESET_EXPIRES_IN,
      });
      await this.audit.record({
        userId: user.id,
        action: 'auth.password_reset.requested',
        entity: 'User',
        entityId: user.id,
      });
      await this.email.send({ ...mail, to: user.email });
    } catch (err) {
      this.logFailure(err);
    }
  }

  /** The error text can echo the address or the link: log only its kind. */
  private logFailure(err: unknown) {
    this.logger.warn(
      `Password reset email failed: ${err instanceof Error ? err.name : 'unknown error'}`,
    );
  }

  /** The user's first branch, else the restaurant's first (for branding). */
  private async branchFor(
    userId: string,
    restaurantId: string,
  ): Promise<string | null> {
    const own = await this.prisma.userBranch.findFirst({
      where: { userId },
      select: { branchId: true },
    });
    if (own) return own.branchId;
    const any = await this.prisma.branch.findFirst({
      where: { restaurantId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return any?.id ?? null;
  }
}
