import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  assertCanManage,
  ceilingUserInclude,
  type CeilingActor,
} from '../common/privilege-ceiling';

/** "Log out of all devices": invalidates every JWT a user holds. */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bumps tokenVersion so every outstanding token fails JwtStrategy, and
   * drops the user's live sockets. A version counter, not a money balance,
   * so the atomic DB increment is the right tool here.
   */
  async revokeAll(userId: string) {
    const { tokenVersion } = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    this.realtime.disconnectUser(userId);
    return tokenVersion;
  }

  /** An admin signs a staff member of their own restaurant out everywhere. */
  async revokeForStaff(
    actor: CeilingActor,
    restaurantId: string,
    targetUserId: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, restaurantId },
      include: ceilingUserInclude,
    });
    if (!target) throw new NotFoundException('Staff member not found');
    // #229: no signing out someone with more access than you (or the owner).
    assertCanManage(actor, target);
    await this.revokeAll(targetUserId);
    await this.audit.record({
      userId: actor.id,
      action: 'sessions.revoked',
      entity: 'User',
      entityId: targetUserId,
    });
    return { ok: true };
  }
}
