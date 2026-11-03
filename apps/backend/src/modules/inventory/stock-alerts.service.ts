import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

const EXPIRY_TYPE = 'stock.expiring';
const LOW_TYPE = 'stock.low';
const ALERT_ENTITY = 'stock-alert';
const MAX_LISTED = 10;

export interface ExpiringRow {
  name: string;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
}
export interface LowRow {
  name: string;
  currentStock: number;
  reorderLevel: number;
}

/** Batches expiring on or before this instant are reported. */
export function expiryCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

const list = (lines: string[]) =>
  lines.slice(0, MAX_LISTED).join('\n') +
  (lines.length > MAX_LISTED ? `\n…and ${lines.length - MAX_LISTED} more` : '');

export function buildDigest(expiring: ExpiringRow[], low: LowRow[]) {
  if (expiring.length === 0 && low.length === 0) return null;
  const expiryBody = list(
    expiring.map(
      (e) =>
        `${e.name} (batch ${e.batchNumber}, ${e.quantity} left) expires ${e.expiryDate.toISOString().slice(0, 10)}`,
    ),
  );
  const lowBody = list(
    low.map(
      (l) => `${l.name}: ${l.currentStock} left (reorder at ${l.reorderLevel})`,
    ),
  );
  return { expiryBody, lowBody };
}

@Injectable()
export class StockAlertsService {
  private readonly logger = new Logger(StockAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly time: BranchTimeService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async tick() {
    try {
      await this.run(new Date());
    } catch (err) {
      this.logger.error(
        `Stock alert run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** One pass over every branch. Safe to repeat: each branch alerts once per local day. */
  async run(now: Date) {
    const restaurants = await this.prisma.restaurant.findMany({
      select: {
        id: true,
        expiryAlertDays: true,
        branches: { select: { id: true } },
      },
    });
    for (const r of restaurants) {
      for (const b of r.branches) {
        try {
          await this.runBranch(b.id, r.expiryAlertDays, now);
        } catch (err) {
          this.logger.warn(
            `Stock alerts for branch ${b.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private async runBranch(branchId: string, days: number, now: Date) {
    const tz = await this.time.tzForBranch(branchId);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

    const [batches, ingredients] = await Promise.all([
      this.prisma.stockBatch.findMany({
        where: {
          branchId,
          quantityRemaining: { gt: 0 },
          expiryDate: { not: null, lte: expiryCutoff(now, days) },
        },
        orderBy: { expiryDate: 'asc' },
        select: {
          batchNumber: true,
          quantityRemaining: true,
          expiryDate: true,
          ingredient: { select: { name: true } },
        },
      }),
      this.prisma.ingredient.findMany({
        where: { branchId, isActive: true, reorderLevel: { gt: 0 } },
        select: { name: true, currentStock: true, reorderLevel: true },
      }),
    ]);

    const expiring: ExpiringRow[] = batches.map((x) => ({
      name: x.ingredient.name,
      batchNumber: x.batchNumber,
      expiryDate: x.expiryDate as Date,
      quantity: Number(x.quantityRemaining),
    }));
    const low: LowRow[] = ingredients
      .map((i) => ({
        name: i.name,
        currentStock: Number(i.currentStock),
        reorderLevel: Number(i.reorderLevel),
      }))
      .filter((i) => i.currentStock <= i.reorderLevel);

    const digest = buildDigest(expiring, low);
    if (!digest) return;

    const sent: string[] = [];
    if (
      expiring.length > 0 &&
      (await this.notifyOnce(
        branchId,
        EXPIRY_TYPE,
        day,
        `${expiring.length} stock batch(es) expiring soon`,
        digest.expiryBody,
      ))
    ) {
      sent.push(`Expiring soon:\n${digest.expiryBody}`);
    }
    if (
      low.length > 0 &&
      (await this.notifyOnce(
        branchId,
        LOW_TYPE,
        day,
        `${low.length} ingredient(s) low on stock`,
        digest.lowBody,
      ))
    ) {
      sent.push(`Low stock:\n${digest.lowBody}`);
    }
    if (sent.length > 0) await this.emailDigest(branchId, sent.join('\n\n'));
  }

  /** Creates the notification unless this branch already got one today. */
  private async notifyOnce(
    branchId: string,
    type: string,
    day: string,
    title: string,
    body: string,
  ): Promise<boolean> {
    const already = await this.prisma.notification.count({
      where: { branchId, type, entity: ALERT_ENTITY, entityId: day },
    });
    if (already > 0) return false;
    await this.notifications.notifyByPermission(branchId, 'inventory.manage', {
      type,
      title,
      body,
      entity: ALERT_ENTITY,
      entityId: day,
    });
    return true;
  }

  private async emailDigest(branchId: string, text: string) {
    if (!this.email.isConfigured()) return;
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        branches: { some: { branchId } },
        role: {
          permissions: { some: { permission: { key: 'inventory.manage' } } },
        },
      },
      select: { email: true },
    });
    await this.email.sendEach(
      users
        .flatMap((u) => (u.email ? [u.email] : []))
        .map((to) => ({
          to,
          subject: 'Stock alert: expiring or low items',
          text,
        })),
    );
  }
}
