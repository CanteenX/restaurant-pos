import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newPasswordSchema, type InviteInfoView } from '@nventra/types';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import { AuthTokensService } from '../../auth/tokens/auth-tokens.service';
import { authLink, publicBaseUrl } from '../../auth/tokens/public-url';
import { KeyRateLimiter } from '../../common/guards/key-rate-limiter';
import {
  assertCanManage,
  ceilingUserInclude,
  type CeilingActor,
} from '../../common/privilege-ceiling';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplatesService } from '../email/templates/email-templates.service';

export const INVITE_TTL_MS = 72 * 60 * 60_000;
/** Invite emails per staff member per hour. */
export const INVITE_RESENDS_PER_USER = 3;
const INVITE_USER_WINDOW_MS = 60 * 60_000;
/** Invite emails per acting admin per day. */
const INVITES_PER_ACTOR_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60_000;
const BCRYPT_COST = 12;

const INVALID_INVITE =
  'This invite link is invalid, already used or expired. Ask your manager to send a new one.';
const WEAK_PASSWORD = 'The new password must be 8 to 200 characters long.';

/**
 * Staff invites by email (#223). An invited account is created inactive with
 * an unusable password; the emailed single-use link (72 h) lets the person
 * set their own password, which activates the account.
 *
 * Send, resend and revoke need `users.manage` (controller) AND the #229
 * privilege ceiling: nobody can invite into, or act on, an account with more
 * access than their own, and only an owner touches an owner. Accept is
 * public; the token is the credential.
 *
 * Never logged: tokens, links, recipient addresses.
 */
@Injectable()
export class StaffInviteService {
  private readonly logger = new Logger(StaffInviteService.name);
  private readonly perUser = new KeyRateLimiter(INVITE_USER_WINDOW_MS);
  private readonly perActor = new KeyRateLimiter(DAY_MS);

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

  /** Whether invites can be emailed at all (SMTP + PUBLIC_URL). */
  isAvailable(): boolean {
    return this.email.isConfigured() && this.baseUrl !== null;
  }

  /** Throws 400 when invites cannot be emailed from this server. */
  assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new BadRequestException(
        'Email invites need SMTP (SMTP_URL, SMTP_FROM) and PUBLIC_URL to be set on the server. Set a password instead.',
      );
    }
  }

  /** Sends (or re-sends) the invite; any earlier link stops working. */
  async send(
    restaurantId: string,
    actor: CeilingActor,
    userId: string,
  ): Promise<{ sent: true }> {
    const target = await this.loadTarget(restaurantId, actor, userId);
    if (target.isActive) {
      throw new ConflictException(
        'This account is already active. Use a password reset instead.',
      );
    }
    if (!target.email) {
      throw new BadRequestException(
        'Add an email address to this account first.',
      );
    }
    this.assertAvailable();
    this.assertBudget(actor.id, userId);
    const base = this.baseUrl as string;

    const { token } = await this.tokens.issue({
      userId,
      restaurantId,
      purpose: 'STAFF_INVITE',
      ttlMs: INVITE_TTL_MS,
      createdById: actor.id,
    });
    const branchId =
      target.branches[0]?.branchId ?? (await this.firstBranch(restaurantId));
    try {
      if (!branchId) throw new Error('NoBranch');
      const compose = await this.templates.forBranchAlways(
        branchId,
        'STAFF_INVITE',
      );
      const mail = compose({
        'staff.name': target.name,
        'invite.role': target.role.label,
        'invite.url': authLink(base, '/accept-invite', token),
      });
      await this.email.send({ ...mail, to: target.email });
    } catch (err) {
      // A link that never arrived must not stay usable.
      await this.tokens.revokeOutstanding(userId, 'STAFF_INVITE');
      this.logger.warn(
        `Staff invite email failed: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
      throw new BadRequestException(
        'The invite email could not be sent. Check the server email settings.',
      );
    }
    await this.audit.record({
      userId: actor.id,
      action: 'staff.invite.sent',
      entity: 'User',
      entityId: userId,
      metadata: { roleId: target.roleId },
    });
    return { sent: true };
  }

  async revoke(
    restaurantId: string,
    actor: CeilingActor,
    userId: string,
  ): Promise<{ revoked: number }> {
    await this.loadTarget(restaurantId, actor, userId);
    const revoked = await this.tokens.revokeOutstanding(userId, 'STAFF_INVITE');
    await this.audit.record({
      userId: actor.id,
      action: 'staff.invite.revoked',
      entity: 'User',
      entityId: userId,
      metadata: { revoked },
    });
    return { revoked };
  }

  /** Drops pending invites (account disabled); ceiling already checked. */
  async dropPending(userId: string): Promise<number> {
    return this.tokens.revokeOutstanding(userId, 'STAFF_INVITE');
  }

  /** Public: who the link is for, so the page can greet them. */
  async inspect(token: string): Promise<InviteInfoView> {
    const claim = await this.tokens.peek(token, 'STAFF_INVITE');
    const user = claim
      ? await this.prisma.user.findFirst({
          where: { id: claim.userId, restaurantId: claim.restaurantId },
          select: { name: true, role: { select: { label: true } } },
        })
      : null;
    const restaurant = claim
      ? await this.prisma.restaurant.findUnique({
          where: { id: claim.restaurantId },
          select: { name: true },
        })
      : null;
    if (!user || !restaurant) throw new BadRequestException(INVALID_INVITE);
    return {
      name: user.name,
      restaurantName: restaurant.name,
      roleLabel: user.role.label,
    };
  }

  /** Public: sets the password and activates the invited account. */
  async accept(token: string, password: string): Promise<{ ok: true }> {
    if (!newPasswordSchema.safeParse(password).success) {
      throw new BadRequestException(WEAK_PASSWORD);
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const userId = await this.tokens.redeem(
      token,
      'STAFF_INVITE',
      async (tx, claim) => {
        const user = await tx.user.findFirst({
          where: { id: claim.userId, restaurantId: claim.restaurantId },
          select: { id: true },
        });
        if (!user) throw new BadRequestException(INVALID_INVITE);
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash,
            isActive: true,
            // Committed with the password and the token claim (#244 review).
            tokenVersion: { increment: 1 },
          },
        });
        return user.id;
      },
    );
    if (!userId) throw new BadRequestException(INVALID_INVITE);
    this.sessions.disconnect(userId);
    await this.audit.record({
      userId,
      action: 'staff.invite.accepted',
      entity: 'User',
      entityId: userId,
    });
    return { ok: true };
  }

  private async loadTarget(
    restaurantId: string,
    actor: CeilingActor,
    userId: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, restaurantId },
      include: {
        ...ceilingUserInclude,
        branches: { select: { branchId: true }, take: 1 },
      },
    });
    if (!target) throw new NotFoundException('Staff account not found');
    // #229: only within the actor's own access; only an owner for an owner.
    assertCanManage(actor, target);
    return target;
  }

  private assertBudget(actorId: string, userId: string) {
    const wait = Math.max(
      this.perUser.hit(`u:${userId}`, INVITE_RESENDS_PER_USER),
      this.perActor.hit(`a:${actorId}`, INVITES_PER_ACTOR_PER_DAY),
    );
    if (wait > 0) {
      throw new HttpException(
        `Too many invite emails. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async firstBranch(restaurantId: string): Promise<string | null> {
    const b = await this.prisma.branch.findFirst({
      where: { restaurantId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return b?.id ?? null;
  }
}
