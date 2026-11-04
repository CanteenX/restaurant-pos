import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { IntegrationOutbox, Prisma } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboundError, type PlatformOrderStatus } from '../providers/provider';
import {
  getProvider,
  listProviders,
  sourceOf,
  supports,
} from '../providers/registry';
import { decryptSecret } from '../secret-box';
import {
  afterFailure,
  ORDER_STATUS_KIND,
  orderStatusDedupeKey,
  toOutboundError,
} from './outbox-policy';

const BATCH = 20;
const CLAIM_MS = 2 * 60_000;

export interface ExternalOrderRef {
  id: string;
  branchId: string;
  externalSource: string | null;
  externalOrderId: string | null;
}

interface OrderStatusPayload {
  externalOrderId: string;
  status: PlatformOrderStatus;
  reason?: string;
  at: string;
}

/**
 * Queues outbound partner calls and delivers them with retry, backoff and a
 * dead letter (docs/AGGREGATORS.md 4.3). Depends only on Prisma and
 * notifications, so OrdersService and DeliveryService can inject it without
 * a module cycle.
 */
@Injectable()
export class IntegrationOutboxService {
  private readonly logger = new Logger(IntegrationOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Records that the platform must be told `status`. Call inside the same
   * transaction as the change. A no-op for orders that did not come from a
   * platform we can talk back to, and for a status already queued.
   */
  async enqueueOrderStatus(
    tx: Prisma.TransactionClient,
    order: ExternalOrderRef,
    status: PlatformOrderStatus,
    reason?: string,
  ): Promise<number> {
    const { externalSource, externalOrderId } = order;
    if (!externalSource || !externalOrderId) return 0;
    const keys = listProviders()
      .filter(
        (p) =>
          sourceOf(p) === externalSource && supports(p, 'updateOrderStatus'),
      )
      .map((p) => p.key);
    if (keys.length === 0) return 0;
    const branch = await tx.branch.findUnique({
      where: { id: order.branchId },
      select: { restaurantId: true },
    });
    if (!branch) return 0;
    const conns = await tx.integrationConnection.findMany({
      where: {
        restaurantId: branch.restaurantId,
        provider: { in: keys },
        enabled: true,
      },
      select: { id: true },
    });
    if (conns.length === 0) return 0;
    const payload: OrderStatusPayload = {
      externalOrderId,
      status,
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
      at: new Date().toISOString(),
    };
    const res = await tx.integrationOutbox.createMany({
      data: conns.map((c) => ({
        connectionId: c.id,
        kind: ORDER_STATUS_KIND,
        dedupeKey: orderStatusDedupeKey(externalOrderId, status),
        orderId: order.id,
        branchId: order.branchId,
        payload: payload as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    await this.flush();
  }

  /** Sends every due row once (the cron's body; tests call it directly). */
  async flush() {
    try {
      const due = await this.prisma.integrationOutbox.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });
      await Promise.all(due.map((d) => this.attempt(d.id)));
    } catch (err) {
      this.logger.error(`integration outbox tick failed: ${String(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup() {
    await this.prisma.integrationOutbox.deleteMany({
      where: {
        status: 'DONE',
        createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) },
      },
    });
  }

  /** One delivery attempt; claims the row first so overlapping ticks never double-send. */
  async attempt(id: string) {
    const row = await this.prisma.integrationOutbox.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'PENDING') return;
    if (await this.waitsForEarlier(row)) return;
    const claimed = await this.prisma.integrationOutbox.updateMany({
      where: { id, status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      data: {
        nextAttemptAt: new Date(Date.now() + CLAIM_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return;
    const attempts = row.attempts + 1;
    try {
      await this.deliver(row);
    } catch (e) {
      await this.failed(row, attempts, toOutboundError(e));
      return;
    }
    await this.succeeded(row);
  }

  /** Per order, statuses go out in the order they happened. */
  private async waitsForEarlier(row: IntegrationOutbox) {
    if (!row.orderId) return false;
    const earlier = await this.prisma.integrationOutbox.count({
      where: {
        connectionId: row.connectionId,
        orderId: row.orderId,
        status: 'PENDING',
        createdAt: { lt: row.createdAt },
      },
    });
    return earlier > 0;
  }

  private async deliver(row: IntegrationOutbox) {
    const conn = await this.prisma.integrationConnection.findUniqueOrThrow({
      where: { id: row.connectionId },
    });
    if (!conn.enabled) {
      throw new OutboundError('The integration is disabled', true);
    }
    const provider = getProvider(conn.provider);
    if (
      !provider?.updateOrderStatus ||
      !supports(provider, 'updateOrderStatus')
    ) {
      throw new OutboundError('This integration cannot send statuses', false);
    }
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(
        decryptSecret(
          conn.credentialsEnc ?? '',
          `${conn.restaurantId}:${conn.provider}`,
        ),
      ) as Record<string, string>;
    } catch {
      throw new OutboundError(
        'The saved credentials can no longer be read - enter them again',
        false,
      );
    }
    const p = row.payload as unknown as OrderStatusPayload;
    await provider.updateOrderStatus(
      {
        restaurantId: conn.restaurantId,
        externalAccountId: conn.externalAccountId,
        credentials,
      },
      p.externalOrderId,
      p.status,
      // The row id is stable across retries, so the partner can dedupe.
      { reason: p.reason, idempotencyKey: row.id, at: p.at },
    );
  }

  private describe(row: IntegrationOutbox) {
    const p = row.payload as unknown as OrderStatusPayload;
    return `${p.status} for order ${p.externalOrderId}`;
  }

  private async succeeded(row: IntegrationOutbox) {
    const now = new Date();
    await this.prisma.integrationOutbox.update({
      where: { id: row.id },
      data: { status: 'DONE', doneAt: now, lastError: null },
    });
    await this.prisma.integrationConnection.update({
      where: { id: row.connectionId },
      data: {
        status: 'CONNECTED',
        lastSyncAt: now,
        lastSuccessAt: now,
        lastError: null,
      },
    });
    await this.log(
      row.connectionId,
      'INFO',
      'status_sent',
      `Sent ${this.describe(row)}`,
    );
  }

  private async failed(
    row: IntegrationOutbox,
    attempts: number,
    err: OutboundError,
  ) {
    const next = afterFailure(attempts, err);
    const msg = `${this.describe(row)}: ${err.message}`.slice(0, 500);
    await this.prisma.integrationOutbox.update({
      where: { id: row.id },
      data: {
        status: next.status,
        nextAttemptAt: next.nextAttemptAt,
        lastError: err.message.slice(0, 300),
      },
    });
    const dead = next.status === 'DEAD';
    const auth = err.httpStatus === 401 || err.httpStatus === 403;
    await this.prisma.integrationConnection.update({
      where: { id: row.connectionId },
      data: {
        lastSyncAt: new Date(),
        lastError: msg,
        ...(dead ? { status: auth ? 'AUTH_EXPIRED' : 'SYNC_ERROR' } : {}),
      },
    });
    if (!dead) {
      await this.log(
        row.connectionId,
        'WARN',
        'status_retry',
        `Will retry ${msg}`,
      );
      return;
    }
    await this.log(
      row.connectionId,
      'ERROR',
      'status_dead',
      `Gave up on ${msg}`,
    );
    if (!row.branchId) return;
    try {
      await this.notifications.notifyByPermission(
        row.branchId,
        'settings.manage',
        {
          type: 'integration.failed',
          title: 'Delivery platform not updated',
          body: `Could not send ${this.describe(row)}. Open Settings > Integrations to retry.`,
          entity: 'IntegrationConnection',
          entityId: row.connectionId,
        },
      );
    } catch (e) {
      this.logger.warn(`notify failed: ${(e as Error).message}`);
    }
  }

  private async log(
    connectionId: string,
    level: 'INFO' | 'WARN' | 'ERROR',
    event: string,
    message: string,
  ) {
    await this.prisma.integrationLog.create({
      data: { connectionId, level, event, message: message.slice(0, 500) },
    });
  }

  /** Re-queues every dead-lettered call of one connection. */
  async retryDead(connectionId: string) {
    const res = await this.prisma.integrationOutbox.updateMany({
      where: { connectionId, status: 'DEAD' },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
    return { requeued: res.count };
  }

  /** Pending / dead counts per connection, for the settings card. */
  async counts(connectionIds: string[]) {
    const rows = await this.prisma.integrationOutbox.groupBy({
      by: ['connectionId', 'status'],
      where: {
        connectionId: { in: connectionIds },
        status: { in: ['PENDING', 'DEAD'] },
      },
      _count: { _all: true },
    });
    const out = new Map<string, { pending: number; dead: number }>();
    for (const r of rows) {
      const c = out.get(r.connectionId) ?? { pending: 0, dead: 0 };
      if (r.status === 'PENDING') c.pending = r._count._all;
      else c.dead = r._count._all;
      out.set(r.connectionId, c);
    }
    return out;
  }
}
