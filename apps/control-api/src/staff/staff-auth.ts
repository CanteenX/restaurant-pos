import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { compare, hash } from 'bcrypt';
import { effectiveControlGrants } from '@nventra/types';
import { generateSecret, generateRecoveryCode, openSecret, sealSecret, verifyTotp } from '@nventra/types/dist/node/totp';

import { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { RoleAccess } from './role-access.js';
import { StaffAccess } from './staff-access.js';
import { StaffLifecycle, type readStaffInviteMail } from './staff-lifecycle.js';
import { appendAuditEvent } from '../audit/audit.js';

const token = () => randomBytes(32).toString('base64url');
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

export class StaffAuth {
  readonly access: StaffAccess;
  readonly roles: RoleAccess;
  readonly lifecycle: StaffLifecycle;
  private constructor(private readonly db: PrismaClient, private readonly key: string,
    readonly origin: string, private readonly dummyHash: string, mail: ReturnType<typeof readStaffInviteMail>) {
    this.access = new StaffAccess(db, (cookie) => this.digest('session', cookie));
    this.roles = new RoleAccess(this.access);
    this.lifecycle = new StaffLifecycle(this.access, origin, mail, (cookie) => this.digest('session', cookie));
  }

  static async create(url: string, key: string, origin: string, mail?: ReturnType<typeof readStaffInviteMail>) {
    const dummy = await hash(token(), 12);
    return new StaffAuth(new PrismaClient({ datasourceUrl: url }), key, origin, dummy, mail);
  }

  async onModuleDestroy() { await this.db.$disconnect(); }

  private digest(kind: string, value: string) {
    return createHmac('sha256', this.key).update(kind).update('\0').update(value).digest('hex');
  }

  private async limit(kind: string, value: string, maximum: number) {
    const bucket = this.digest(kind, value);
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      INSERT INTO control.auth_limit AS b (bucket, attempts, expires_at)
      VALUES (${bucket}, 1, now() + interval '10 minutes')
      ON CONFLICT (bucket) DO UPDATE SET
        attempts = CASE WHEN b.expires_at <= now() THEN 1 ELSE b.attempts + 1 END,
        expires_at = CASE WHEN b.expires_at <= now() THEN EXCLUDED.expires_at ELSE b.expires_at END
      WHERE b.expires_at <= now() OR b.attempts < ${maximum}
      RETURNING attempts
    `;
    if (!rows.length) throw new HttpException('Too many attempts', 429);
  }

  private async limitPeer(stage: string, ip: string) {
    await this.limit(stage + ':peer', ip, 24);
    await this.db.$executeRaw`DELETE FROM control.auth_limit WHERE expires_at <= now() AND bucket IN
      (SELECT bucket FROM control.auth_limit WHERE expires_at <= now() LIMIT 64)`;
  }

  async challenge(email: string, password: string, ip: string, enrollmentProof?: string) {
    await this.limitPeer('challenge', ip);
    await this.limit('challenge:account', email, 8);
    const staff = await this.db.staff.findUnique({ where: { email } });
    const valid = await compare(password, staff?.passwordHash ?? this.dummyHash);
    if (!valid || !staff?.enabled || (staff.encryptedSeed && enrollmentProof)) {
      throw new UnauthorizedException();
    }
    return this.db.$transaction(async (tx) => {
      let enrollmentSecret: string | undefined;
      if (!staff.encryptedSeed) {
        if (!enrollmentProof) throw new UnauthorizedException();
        const [{ used }] = await tx.$queryRaw<{ used: boolean }[]>`SELECT control.consume_staff_enrollment(
          ${staff.id}::uuid, ${Buffer.from(enrollmentProof, 'base64url')}::bytea) AS used`;
        if (!used) throw new UnauthorizedException();
        enrollmentSecret = generateSecret();
      }
      const challenge = token();
      const changed = await tx.staff.updateMany({
        where: { id: staff.id, enabled: true, passwordHash: staff.passwordHash, encryptedSeed: staff.encryptedSeed, credentialVersion: staff.credentialVersion },
        data: { challengeDigest: this.digest('challenge', challenge), challengeExpiresAt: minutes(5),
          pendingSeed: enrollmentSecret ? sealSecret(enrollmentSecret, this.key + staff.id) : null },
      });
      if (!changed.count) throw new UnauthorizedException();
      return { challenge, enrollmentSecret };
    });
  }

  async acceptInvite(proof: string, password: string, ip: string) {
    await this.limitPeer('invite', ip);
    const verifier = await hash(password, 12);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('control.staff_roles'))`;
      const [{ id }] = await tx.$queryRaw<{ id: string | null }[]>`
        SELECT control.redeem_staff_invite(${Buffer.from(proof, 'base64url')}::bytea, ${verifier}) AS id`;
      if (!id) throw new UnauthorizedException();
      const staff = await tx.staff.findUniqueOrThrow({ where: { id }, select: { extraGrants: true, removedGrants: true,
        role: { select: { grants: true } } } });
      const challenge = token(), enrollmentSecret = generateSecret();
      await tx.staff.update({ where: { id }, data: {
        grants: effectiveControlGrants(staff.role?.grants ?? [], staff.extraGrants, staff.removedGrants),
        challengeDigest: this.digest('challenge', challenge), challengeExpiresAt: minutes(5),
        pendingSeed: sealSecret(enrollmentSecret, this.key + id),
      } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: id, action: 'staff.invite.accept',
        subjectType: 'staff', subjectId: id, requestId: randomUUID(), outcome: 'succeeded' });
      return { challenge, enrollmentSecret };
    });
  }

  async factor(challenge: string, code: string, ip: string, enrollment: boolean) {
    await this.limitPeer('factor', ip);
    const challengeDigest = this.digest('challenge', challenge);
    const staff = await this.db.staff.findUnique({ where: { challengeDigest } });
    if (!staff?.enabled || !staff.challengeExpiresAt || staff.challengeExpiresAt <= new Date()) {
      throw new UnauthorizedException();
    }
    await this.limit('factor:account', staff.id, 12);
    const sealed = enrollment ? staff.pendingSeed : staff.encryptedSeed;
    if (!sealed || enrollment === Boolean(staff.encryptedSeed)) throw new UnauthorizedException();
    const step = verifyTotp(openSecret(sealed, this.key + staff.id), code);
    const recovery = this.digest('recovery:' + staff.id, code);
    const validRecovery = !enrollment && staff.recoveryDigests.includes(recovery);
    if (!validRecovery && (step === null || step <= (staff.lastStep ?? -1))) throw new UnauthorizedException();

    const recoveryCodes = enrollment ? Array.from({ length: 8 }, generateRecoveryCode) : undefined;
    const session = token();
    await this.db.$transaction(async (tx) => {
      const used = await tx.staff.updateMany({
        where: { id: staff.id, enabled: true, challengeDigest, challengeExpiresAt: { gt: new Date() } },
        data: { challengeDigest: null, challengeExpiresAt: null, pendingSeed: null, encryptedSeed: sealed,
          lastStep: step ?? staff.lastStep, recoveryDigests: recoveryCodes
            ? recoveryCodes.map((c) => this.digest('recovery:' + staff.id, c))
            : staff.recoveryDigests.filter((c) => c !== recovery) },
      });
      if (!used.count) throw new UnauthorizedException();
      await tx.staffSession.deleteMany({ where: { staffId: staff.id, expiresAt: { lte: new Date() } } });
      await tx.staffSession.create({ data: {
        digest: this.digest('session', session), staffId: staff.id, expiresAt: minutes(480), verifiedAt: new Date(),
      } });
      await appendAuditEvent(tx, { actorType: 'staff', actorId: staff.id, action: enrollment ? 'staff.enroll' : 'staff.login',
        subjectType: 'staff', subjectId: staff.id, requestId: randomUUID(), outcome: 'succeeded' });
    });
    return { session, recoveryCodes };
  }

  async session(value: string) {
    const now = new Date();
    const record = await this.db.staffSession.findFirst({
      where: { digest: this.digest('session', value), expiresAt: { gt: now }, verifiedAt: { lte: now }, staff: { enabled: true } },
      select: { staffId: true, verifiedAt: true, staff: { select: { grants: true } } },
    });
    if (!record) throw new UnauthorizedException();
    return { staffId: record.staffId, verifiedAt: record.verifiedAt, grants: record.staff.grants };
  }

  async logout(value: string) {
    const digest = this.digest('session', value);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT s.id FROM control.staff s JOIN control.staff_session ss ON s.id = ss.staff_id
        WHERE ss.digest = ${digest} FOR UPDATE OF s`;
      await tx.staffSession.deleteMany({ where: { digest } });
    });
  }
}
