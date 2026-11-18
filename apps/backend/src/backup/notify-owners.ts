import type { PrismaService } from '../prisma/prisma.service';
import type {
  NotificationsService,
  NotifyPayload,
} from '../notifications/notifications.service';

// Instance-wide event -> notify every OWNER-role user across every
// restaurant on this instance (not just the acting user's own
// restaurant), because a backup/restore affects the entire shared
// Postgres instance, not one tenant. `Notification` rows are
// branch-scoped (schema.prisma), so each Owner is attached to their
// oldest (first-created) branch — a reasonable stand-in "primary" branch
// since there's no meaningful branch to prefer for an instance-wide
// event. An Owner with no branch assignment is skipped rather than
// failing the whole operation.
export async function notifyOwners(
  prisma: PrismaService,
  notifications: NotificationsService,
  payload: NotifyPayload,
): Promise<void> {
  const owners = await prisma.user.findMany({
    where: { role: { name: 'OWNER' }, isActive: true },
    select: {
      id: true,
      branches: {
        select: { branchId: true },
        orderBy: { branch: { createdAt: 'asc' } },
        take: 1,
      },
    },
  });

  for (const owner of owners) {
    const branchId = owner.branches[0]?.branchId;
    if (!branchId) continue;
    await notifications.notifyUser(owner.id, branchId, payload);
  }
}
