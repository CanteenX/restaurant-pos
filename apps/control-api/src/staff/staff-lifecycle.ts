import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { canManageControlStaff, type controlStaffInvite } from '@nventra/types';
import type { z } from 'zod';
import { appendAuditEvent } from '../audit/audit.js';
import { createGmailSmtp } from '../helpdesk/mail/gmail-smtp.js';
import type { StaffAccess } from './staff-access.js';

export function invitationDigest(token: string) {
  return createHash('sha256').update(Buffer.from(token, 'base64url')).digest();
}

export function readStaffInviteMail(env: NodeJS.ProcessEnv) {
  const flag = env.CONTROL_STAFF_INVITE_MAIL_ENABLED;
  if (flag === undefined || flag === 'false') return undefined;
  if (flag !== 'true') throw new Error('Invalid Control staff invitation mail configuration');
  return createGmailSmtp(env);
}

const staffFields = { id: true, email: true, enabled: true, grants: true, roleId: true } as const;

export class StaffLifecycle {
  constructor(private readonly access: StaffAccess, private readonly origin: string,
    private readonly mail: ReturnType<typeof readStaffInviteMail>) {}

  async invite(cookie: string, dto: z.infer<typeof controlStaffInvite>) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = await this.access.withPermission(cookie, 'cc.staff.manage', async (tx, actor) => {
      const role = await tx.staffRole.findUnique({ where: { id: dto.roleId } });
      if (!role) throw new NotFoundException();
      const { extraGrants, removedGrants } = dto;
      if ([...role.grants, ...extraGrants, ...removedGrants].some((grant) => !actor.grants.includes(grant))) {
        throw new ForbiddenException();
      }
      if (role.isSystem && (extraGrants.length || removedGrants.length)) throw new BadRequestException();
      const [{ expiresAt }] = await tx.$queryRaw<{ expiresAt: Date | null }[]>`
        SELECT control.issue_staff_invite(${id}::uuid, ${dto.email}, ${role.id}::uuid, ${actor.id}::uuid,
          ${invitationDigest(token)}::bytea, ${role.grants}::text[], ${extraGrants}::text[], ${removedGrants}::text[]) AS "expiresAt"`;
      if (!expiresAt) throw new ConflictException();
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, action: 'staff.invite.issue', subjectType: 'staff',
        subjectId: id, requestId: randomUUID(), outcome: 'succeeded', changedFields: ['roleId'] });
      return expiresAt;
    }, { recent: true, serialize: true });

    const inviteLink = this.origin + '/#token=' + token;
    if (!this.mail) return { id, expiresAt, delivery: 'manual', inviteLink };
    const body = 'Set your Nventra Control Center password and enrol your authenticator within 72 hours.';
    // Sending after the commit prevents a delivered invitation from pointing at a rolled-back row.
    const result = await this.mail.send({ to: dto.email, messageId: '<' + id + '@control.nventra.invalid>',
      subject: 'Your Nventra Control Center invitation', text: body + '\n' + inviteLink,
      html: '<p>' + body + '</p><p><a href="' + inviteLink + '">Accept invitation</a></p>' });
    return { id, expiresAt, delivery: result.status === 'sent' ? 'sent' : 'unconfirmed' };
  }

  setEnabled(cookie: string, id: string, enabled: boolean) {
    return this.access.withPermission(cookie, 'cc.staff.manage', async (tx, actor) => {
      const subject = await tx.staff.findUnique({ where: { id }, select: staffFields });
      if (!subject) throw new NotFoundException();
      if (!canManageControlStaff({ staffId: actor.id, grants: actor.grants },
        { staffId: id, grants: subject.grants }, subject.grants)) throw new ForbiddenException();
      if (subject.enabled === enabled) return subject;
      const [{ changed }] = await tx.$queryRaw<{ changed: boolean }[]>`
        SELECT control.set_staff_enabled(${id}::uuid, ${enabled}) AS changed`;
      if (!changed) throw new ConflictException();
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id,
        action: enabled ? 'staff.reactivate' : 'staff.deactivate', subjectType: 'staff',
        subjectId: id, requestId: randomUUID(), outcome: 'succeeded', changedFields: ['enabled'] });
      return { ...subject, enabled };
    }, { recent: true, staffTarget: id, serialize: true });
  }
}
