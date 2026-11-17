import {
  ForbiddenException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  STAFF_ROLES,
  type LoginDto,
  type PinLoginDto,
  type RegisterDto,
  type SessionUser,
} from '@nventra/types';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { FailureLockout } from './failure-lockout';
import { PasswordCheckService } from './password-check.service';
import {
  LAST_OWNER_TX_OPTIONS,
  hasAnotherActiveOwner,
} from '../common/last-owner';
import { DUMMY_PASSWORD_HASH } from './dummy-hash';
import { emailAccountQuery } from './account-lookup';
import { TwoFactorService } from './two-factor.service';
import {
  effectivePermissions,
  permissionInclude,
  type PermissionSource,
} from './effective-permissions';

// PIN brute-force limits (see pinLogin). A 4-digit PIN has 10,000 values, so
// guessing is capped per account AND per client address, not just by the
// route throttle.
export const PIN_MAX_FAILURES = 5;
export const PIN_IP_MAX_FAILURES = 20;
const PIN_LOCK_MS = 15 * 60_000;
const PIN_FAILED = 'Incorrect PIN or PIN login not available for this user';

@Injectable()
export class AuthService {
  private readonly pinUserLock = new FailureLockout(
    PIN_MAX_FAILURES,
    PIN_LOCK_MS,
  );
  private readonly pinIpLock = new FailureLockout(
    PIN_IP_MAX_FAILURES,
    PIN_LOCK_MS,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
    private readonly passwordCheck: PasswordCheckService,
  ) {}

  private toSessionUser(user: {
    id: string;
    restaurantId: string;
    name: string;
    roleId: string;
    tokenVersion: number;
    role: { name: string; permissions: { permission: { key: string } }[] };
    permissionOverrides?: PermissionSource['permissionOverrides'];
  }): SessionUser {
    return {
      id: user.id,
      restaurantId: user.restaurantId,
      name: user.name,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions: effectivePermissions(user),
    };
  }

  /**
   * Delete my own account (an app-store requirement). The person's details are
   * erased and the login closed; order and payment rows that point at the user
   * stay, because tax records must be kept. The last active owner cannot do
   * this, or the restaurant would be locked out.
   */
  async deleteOwnAccount(userId: string, password: string, ip = 'unknown') {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    // Rate-limited and locked out like login (#236 review).
    if (!user || !(await this.passwordCheck.verify(user, password, ip))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    const scrambled = await bcrypt.hash(
      `${userId}:${Date.now()}:${Math.random()}`,
      10,
    );
    // The last-owner check runs under the same row lock, in the same
    // transaction, as the write (#236 review), so an owner closing their
    // account while the other owner is being disabled cannot leave none.
    await this.prisma.$transaction(async (tx) => {
      if (
        user.role.name === 'OWNER' &&
        !(await hasAnotherActiveOwner(tx, user.restaurantId, user.id))
      ) {
        throw new ConflictException(
          'You are the only owner. Make someone else an owner first, or contact support to close the restaurant.',
        );
      }
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({
        where: { recipientUserId: userId },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          name: 'Deleted user',
          email: null,
          phone: null,
          passwordHash: scrambled,
          pinHash: null,
          isActive: false,
          riderOnline: false,
          riderLat: null,
          riderLng: null,
          riderLocationAt: null,
          dashboardPrefs: Prisma.JsonNull,
          twoFactorSecret: null,
          twoFactorEnabled: false,
          twoFactorRecoveryHashes: [],
        },
      });
    }, LAST_OWNER_TX_OPTIONS);
    return { ok: true };
  }

  async login(dto: LoginDto) {
    const id = dto.email.trim();
    // An email address, or a phone number as the login ID (delivery riders).
    // Every failure gives the same message and runs bcrypt at least once (on
    // the dummy hash if no account matches), so neither the text nor the
    // response time reveals which IDs exist.
    const user = id.includes('@')
      ? await this.findEmailCandidate(id, dto.password)
      : await this.findLoginCandidate(id, dto.password);
    if (!user) {
      throw new UnauthorizedException('Invalid login ID or password');
    }

    // Only asked for after the password is right, so the response never
    // reveals which emails exist or which accounts use two-factor.
    if (user.twoFactorEnabled) {
      await this.twoFactor.verifyLogin(user, dto.totp);
    }

    return this.issueSession(user);
  }

  /**
   * Email login through the shared resolver (account-lookup.ts, also used by
   * password reset): any case, oldest account first. The same address can
   * exist in several restaurants; the password decides which one. No match
   * still costs one bcrypt compare against the dummy hash.
   */
  private async findEmailCandidate(email: string, password: string) {
    const matches = await this.prisma.user.findMany({
      ...emailAccountQuery(email),
      include: permissionInclude,
    });
    for (const u of matches) {
      if (await bcrypt.compare(password, u.passwordHash)) return u;
    }
    if (matches.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    }
    return null;
  }

  /** Phone-number login: compare real digits, then the password, against every active match. */
  private async findLoginCandidate(id: string, password: string) {
    const tail = id.replace(/\D/g, '').slice(-10);
    const candidates =
      tail.length < 6
        ? []
        : await this.prisma.user.findMany({
            where: { isActive: true, phone: { endsWith: tail.slice(-6) } },
            include: permissionInclude,
            take: 10,
          });
    const matches = candidates.filter(
      (u) => (u.phone ?? '').replace(/\D/g, '').slice(-10) === tail,
    );
    for (const u of matches) {
      if (await bcrypt.compare(password, u.passwordHash)) return u;
    }
    if (matches.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    }
    return null;
  }

  async register(dto: RegisterDto) {
    // Sign-up is first-run setup. Once the server has a restaurant, anyone on
    // the network creating another would get an OWNER role - which carries the
    // instance-wide backup, update and sync permissions - so it stays closed
    // unless the host opts in (ALLOW_PUBLIC_SIGNUP=true) to run several tenants.
    if (
      process.env.ALLOW_PUBLIC_SIGNUP !== 'true' &&
      (await this.hasAnyRestaurant())
    ) {
      throw new ForbiddenException(
        'Sign-up is closed on this server. Ask the restaurant owner to create your account.',
      );
    }
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BadRequestException(
        'An account with this email already exists',
      );
    }

    // Permissions are global, not per-tenant — upsert (idempotent) outside
    // the transaction below rather than re-creating them per restaurant.
    for (const permission of PERMISSIONS) {
      await this.prisma.permission.upsert({
        where: { key: permission.key },
        update: {},
        create: permission,
      });
    }
    const allPermissions = await this.prisma.permission.findMany();
    const permissionByKey = new Map(allPermissions.map((p) => [p.key, p]));

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const owner = await this.prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: { name: dto.restaurantName },
      });
      const branch = await tx.branch.create({
        data: { restaurantId: restaurant.id, name: dto.branchName },
      });

      let ownerRoleId = '';
      for (const roleName of STAFF_ROLES) {
        const role = await tx.role.create({
          data: {
            restaurantId: restaurant.id,
            name: roleName,
            label: roleName.replace(/_/g, ' '),
          },
        });
        if (roleName === 'OWNER') ownerRoleId = role.id;

        const grantedKeys = DEFAULT_ROLE_PERMISSIONS[roleName];
        await tx.rolePermission.createMany({
          data: grantedKeys
            .map((key) => permissionByKey.get(key))
            .filter((p): p is NonNullable<typeof p> => Boolean(p))
            .map((permission) => ({
              roleId: role.id,
              permissionId: permission.id,
            })),
        });
      }

      const user = await tx.user.create({
        data: {
          restaurantId: restaurant.id,
          roleId: ownerRoleId,
          name: dto.ownerName,
          email: dto.email,
          passwordHash,
        },
        include: permissionInclude,
      });

      await tx.userBranch.create({
        data: { userId: user.id, branchId: branch.id },
      });

      return user;
    });

    return this.issueSession(owner);
  }

  async hasAnyRestaurant(): Promise<boolean> {
    const restaurant = await this.prisma.restaurant.findFirst({
      select: { id: true },
    });
    return restaurant !== null;
  }

  /**
   * Quick-switch login on a shared terminal. Threat: someone at (or on the
   * network of) the terminal guessing a colleague's 4-8 digit PIN. Defences:
   * per-user lock after PIN_MAX_FAILURES (423), per-IP lock after
   * PIN_IP_MAX_FAILURES across all users (429), one generic error for every
   * failure (unknown, inactive, no PIN, wrong PIN), a real bcrypt compare on
   * every path, and an audit row per attempt. The PIN is never logged.
   */
  async pinLogin(dto: PinLoginDto, ip = 'unknown') {
    const userKey = `u:${dto.userId}`;
    const ipKey = `ip:${ip}`;
    const ipWait = this.pinIpLock.lockedFor(ipKey);
    if (ipWait) {
      throw new HttpException(
        `Too many incorrect PINs from this device. Try again in ${Math.ceil(ipWait / 60)} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const userWait = this.pinUserLock.lockedFor(userKey);
    if (userWait) {
      throw new HttpException(
        `Too many incorrect PINs. PIN login is locked for ${Math.ceil(userWait / 60)} minutes — sign in with your password.`,
        HttpStatus.LOCKED,
      );
    }

    const found = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      include: permissionInclude,
    });
    // A 4-8 digit PIN must not be a way around the second factor, so a
    // two-factor account is treated exactly like one without a PIN: every
    // attempt takes the generic failure path and reveals neither the PIN
    // nor whether two-factor is on.
    const user =
      found?.isActive && found.pinHash && !found.twoFactorEnabled
        ? found
        : null;
    const valid = await bcrypt.compare(
      dto.pin,
      user?.pinHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !valid) {
      await this.recordPinFailure(userKey, ipKey, ip, user?.id ?? null);
      throw new UnauthorizedException(PIN_FAILED);
    }
    this.pinUserLock.reset(userKey);

    await this.audit.record({
      userId: user.id,
      action: 'auth.pin_login.success',
      entity: 'User',
      entityId: user.id,
      metadata: { ip },
    });
    return this.issueSession(user);
  }

  private async recordPinFailure(
    userKey: string,
    ipKey: string,
    ip: string,
    userId: string | null,
  ) {
    const userLocked = this.pinUserLock.fail(userKey);
    const ipLocked = this.pinIpLock.fail(ipKey);
    // An unknown ID has no user row to point at (AuditLog.userId is a FK).
    const base = { userId, entity: 'User', entityId: userId };
    await this.audit.record({
      ...base,
      action: 'auth.pin_login.failure',
      metadata: { ip, knownUser: userId !== null },
    });
    if (userLocked || ipLocked) {
      await this.audit.record({
        ...base,
        action: 'auth.pin_login.locked',
        metadata: { ip, scope: userLocked ? 'user' : 'ip' },
      });
    }
  }

  private async issueSession(
    user: Parameters<AuthService['toSessionUser']>[0],
  ) {
    const sessionUser = this.toSessionUser(user);
    const token = await this.jwt.signAsync({
      sub: user.id,
      tv: user.tokenVersion,
      auth_time: Math.floor(Date.now() / 1000),
    });
    return { token, user: sessionUser };
  }
}
