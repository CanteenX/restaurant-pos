import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { appendAuditEvent } from '../audit/audit.js';
import type { StaffAccess } from '../staff/staff-access.js';
import type { PortalAuth } from './portal-auth.js';
import { portalToken } from './portal-identity-policy.js';

type Account = { id: string; email: string; status: 'pending' | 'active' | 'revoked' };
type ActivatedAccount = Account & { expiresAt: Date | null };
type Command = { kind: 'provision'; email: string } | { kind: 'reissue' | 'revoke'; accountId: string };

export class PortalAccounts {
  constructor(private readonly staff: StaffAccess, private readonly auth: PortalAuth) {}

  list(cookie: string, businessId: string, { cursor, limit }: { cursor?: string; limit: number }) {
    return this.staff.withPermission(cookie, 'cc.portal.read', async (tx) => {
      const business = await tx.business.findUnique({ where: { id: businessId }, select: { id: true } });
      if (!business) throw new NotFoundException();
      const rows = await tx.$queryRaw<Account[]>`SELECT id,email,status FROM control.portal_account
        WHERE business_id = ${businessId}::uuid AND (${cursor ?? null}::uuid IS NULL OR id > ${cursor ?? null}::uuid)
        ORDER BY id LIMIT ${limit + 1}`;
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    });
  }

  change(cookie: string, businessId: string, command: Command) {
    return this.staff.withPermission(cookie, command.kind === 'provision' ? 'cc.portal.create' : 'cc.portal.manage', async (tx, actor) => {
      const revoked = command.kind === 'revoke';
      const code = revoked ? undefined : portalToken();
      const digest = code ? this.auth.activationDigest(code) : null;
      let saved: ActivatedAccount;
      if (command.kind === 'provision') {
        await this.requireActiveBusiness(tx, businessId);
        saved = await this.provision(tx, businessId, command.email, digest);
      } else {
        // Match customer requests: acquire the account lock before the business lock.
        saved = await this.changeExisting(tx, businessId, command.accountId, digest);
        if (!revoked) await this.requireActiveBusiness(tx, businessId);
      }
      const { id, email, status, expiresAt } = saved;
      const account = { id, email, status };
      await appendAuditEvent(tx, { actorType: 'staff', actorId: actor.id, businessId, action: 'portalAccount.' + command.kind,
        subjectType: 'portalAccount', subjectId: id, requestId: randomUUID(), outcome: 'succeeded', changedFields: ['status'] });
      return code && expiresAt ? { account, activationCode: code, expiresAt: expiresAt.toISOString() } : account;
    }, { recent: true });
  }

  private async requireActiveBusiness(tx: Prisma.TransactionClient, businessId: string) {
    const [business] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM control.business
      WHERE id = ${businessId}::uuid FOR SHARE`;
    if (!business) throw new NotFoundException();
    if (business.archived) throw new ConflictException();
  }

  private async provision(tx: Prisma.TransactionClient, businessId: string, email: string, digest: string | null) {
    const [row] = await tx.$queryRaw<ActivatedAccount[]>`INSERT INTO control.portal_account
      (id, business_id, email, status, activation_digest, activation_expires_at)
      VALUES (${randomUUID()}::uuid, ${businessId}::uuid, ${email}, 'pending', ${digest},
        clock_timestamp() + interval '10 minutes') ON CONFLICT (email) DO NOTHING
      RETURNING id,email,status,activation_expires_at AS "expiresAt"`;
    if (!row) throw new ConflictException();
    return row;
  }

  private async changeExisting(tx: Prisma.TransactionClient, businessId: string, accountId: string, digest: string | null) {
    const [row] = await tx.$queryRaw<ActivatedAccount[]>`UPDATE control.portal_account SET
      status = ${digest ? 'pending' : 'revoked'}, password_hash = NULL, activation_digest = ${digest},
      activation_expires_at = CASE WHEN ${digest}::text IS NULL THEN NULL ELSE clock_timestamp() + interval '10 minutes' END
      WHERE id = ${accountId}::uuid AND business_id = ${businessId}::uuid
      RETURNING id,email,status,activation_expires_at AS "expiresAt"`;
    if (!row) throw new NotFoundException();
    return row;
  }
}
