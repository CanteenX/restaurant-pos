import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CheckoutDto } from '@nventra/types';
import { AuditService } from '../../audit/audit.service';
import { KeyRateLimiter } from '../../common/guards/key-rate-limiter';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplatesService } from '../email/templates/email-templates.service';
import { buildReceiptEmailValues } from './receipt-email.values';
import { toEscposOrder } from './receipt-order';

const RESEND_PER_ORDER = 3;
const RESEND_WINDOW_MS = 10 * 60_000;
const RESEND_PER_RESTAURANT = 30;
const RESTAURANT_WINDOW_MS = 60 * 60_000;

/** A send that has been SENDING this long is treated as dead and can be retried. */
const SENDING_TIMEOUT_MS = 10 * 60_000;
/** Statuses no send has claimed, so capture may still change or remove them. */
const UNCLAIMED = ['PENDING', 'FAILED', 'SKIPPED'];
const isStale = (updatedAt: Date | undefined) =>
  !updatedAt || Date.now() - updatedAt.getTime() > SENDING_TIMEOUT_MS;

const errorKind =(err: unknown) =>
  err instanceof Error ? err.name : 'unknown error';

export interface CaptureInput {
  orderId: string;
  branchId: string;
  customerId: string | null;
  dto: Pick<CheckoutDto, 'receiptEmail' | 'receiptEmailConsent'>;
}

/** Masks an address for display: "a***@example.com". */
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 1)}***@${domain ?? ''}`;
}

/**
 * Digital receipt emails (#222). One ReceiptEmail row per order is the
 * idempotency key: the row is claimed atomically (PENDING/FAILED -> SENDING)
 * before anything is sent, so a repeated payment event or a double click can
 * never mail the same receipt twice. Addresses are never logged.
 *
 * The receipt data is the paid order exactly as stored (the same figures the
 * printed receipt uses); the restaurant's template only changes the wording
 * and branding around it. A turned-off template means no automatic send.
 */
@Injectable()
export class ReceiptEmailService {
  private readonly logger = new Logger(ReceiptEmailService.name);
  private readonly orderLimiter = new KeyRateLimiter(RESEND_WINDOW_MS);
  private readonly restaurantLimiter = new KeyRateLimiter(RESTAURANT_WINDOW_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly templates: EmailTemplatesService,
    private readonly audit: AuditService,
  ) {}

  private loadOrder(where: object) {
    return this.prisma.order.findFirst({
      where,
      include: {
        table: true,
        customer: true,
        items: { include: { modifiers: true } },
        payments: true,
        branch: { include: { restaurant: true } },
      },
    });
  }

  /**
   * Called from checkout. Stores the address the guest agreed to (or the one
   * saved on the customer from an earlier consent). Without consent nothing
   * is stored. Never throws: a receipt problem must not fail a payment.
   */
  async capture(input: CaptureInput): Promise<void> {
    try {
      await this.captureUnsafe(input);
    } catch (err) {
      this.logger.warn(
        `Receipt email capture for order ${input.orderId} failed: ${errorKind(err)}`,
      );
    }
  }

  private async captureUnsafe({
    orderId,
    branchId,
    customerId,
    dto,
  }: CaptureInput) {
    // A withdrawal is always recorded, even while the owner setting is off,
    // so turning the feature back on can never mail a guest who opted out.
    if (dto.receiptEmailConsent === false) {
      await this.prisma.receiptEmail.deleteMany({
        where: { orderId, status: { in: UNCLAIMED } },
      });
      if (customerId)
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { receiptEmail: null, receiptConsentAt: null },
        });
      return;
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      select: {
        branch: {
          select: {
            restaurantId: true,
            restaurant: { select: { digitalReceiptsEnabled: true } },
          },
        },
      },
    });
    if (!order?.branch.restaurant.digitalReceiptsEnabled) return;
    const restaurantId = order.branch.restaurantId;
    const now = new Date();

    // The address comes only from this checkout's explicit consent, or from
    // the address saved with an earlier consent. customer.email is never
    // read or written: it belongs to marketing and may be old or mistyped.
    let toEmail: string | undefined;
    let consentAt = now;
    if (dto.receiptEmailConsent === true && dto.receiptEmail) {
      toEmail = dto.receiptEmail;
      if (customerId)
        await this.prisma.customer.update({
          where: { id: customerId },
          data: { receiptEmail: toEmail, receiptConsentAt: now },
        });
    } else if (
      dto.receiptEmailConsent === undefined &&
      !dto.receiptEmail &&
      customerId
    ) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { receiptEmail: true, receiptConsentAt: true },
      });
      if (customer?.receiptEmail) {
        toEmail = customer.receiptEmail;
        consentAt = customer.receiptConsentAt ?? now;
      }
    }
    if (!toEmail) return;

    // Atomic: create the row, or, when one exists, change it only while no
    // send has claimed it (a row that is SENDING or SENT is left alone).
    try {
      await this.prisma.receiptEmail.create({
        data: { orderId, restaurantId, toEmail, consentAt },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      await this.prisma.receiptEmail.updateMany({
        where: { orderId, status: { in: UNCLAIMED } },
        data: { toEmail, consentAt, status: 'PENDING', lastError: null },
      });
    }
  }

  /** Automatic send once an order is fully paid. Never throws. */
  async sendAfterPayment(orderId: string): Promise<void> {
    try {
      await this.sendAfterPaymentUnsafe(orderId);
    } catch (err) {
      this.logger.warn(
        `Receipt email for order ${orderId} failed: ${errorKind(err)}`,
      );
    }
  }

  private async sendAfterPaymentUnsafe(orderId: string) {
    const row = await this.prisma.receiptEmail.findUnique({
      where: { orderId },
    });
    if (!row || row.status === 'SENT') return;
    if (row.status === 'SENDING' && !isStale(row.updatedAt)) return;
    const order = await this.loadOrder({ id: orderId });
    if (!order || order.status !== 'PAID') return;
    if (!order.branch.restaurant.digitalReceiptsEnabled) return;
    const compose = await this.templates.forBranch(order.branchId, 'RECEIPT');
    if (!compose) {
      // The restaurant turned this email off: no automatic send. A resend
      // explains how to turn it back on.
      await this.prisma.receiptEmail.update({
        where: { orderId },
        data: { status: 'SKIPPED', lastError: 'template turned off' },
      });
      return;
    }
    if (!(await this.claim(orderId, ['PENDING', 'FAILED']))) return;
    await this.deliver(order, row.toEmail, compose);
  }

  /** Atomically takes the send; false when someone else already did. */
  private async claim(orderId: string, from: string[]): Promise<boolean> {
    // A row stuck in SENDING (process died mid-send) becomes claimable again
    // after SENDING_TIMEOUT_MS.
    const { count } = await this.prisma.receiptEmail.updateMany({
      where: {
        orderId,
        OR: [
          { status: { in: from } },
          {
            status: 'SENDING',
            updatedAt: { lt: new Date(Date.now() - SENDING_TIMEOUT_MS) },
          },
        ],
      },
      data: { status: 'SENDING' },
    });
    return count > 0;
  }

  private async deliver(
    order: NonNullable<Awaited<ReturnType<ReceiptEmailService['loadOrder']>>>,
    to: string,
    compose: NonNullable<
      Awaited<ReturnType<EmailTemplatesService['forBranch']>>
    >,
  ): Promise<boolean> {
    try {
      const mail = compose(
        buildReceiptEmailValues({
          currency: order.branch.restaurant.currency,
          timeZone: order.branch.restaurant.timezone,
          branch: order.branch,
          order: toEscposOrder(order),
        }),
      );
      await this.email.send({
        to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      });
    } catch (err) {
      // SMTP errors can echo the address: keep only the error kind.
      this.logger.warn(
        `Receipt email for order ${order.id} failed: ${errorKind(err)}`,
      );
      await this.prisma.receiptEmail.update({
        where: { orderId: order.id },
        data: { status: 'FAILED', lastError: errorKind(err) },
      });
      return false;
    }
    await this.prisma.receiptEmail.update({
      where: { orderId: order.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        lastError: null,
        sendCount: { increment: 1 },
      },
    });
    return true;
  }

  /** Delivery state for the order screen; the address is masked. */
  async status(restaurantId: string, orderId: string) {
    const row = await this.prisma.receiptEmail.findFirst({
      where: { orderId, restaurantId },
    });
    if (!row) return { hasEmail: false as const };
    return {
      hasEmail: true as const,
      status: row.status,
      sendCount: row.sendCount,
      sentAt: row.sentAt?.toISOString() ?? null,
      maskedEmail: maskEmail(row.toEmail),
    };
  }

  /** Staff resend to the address the guest gave. Rate-limited. */
  async resend(
    restaurantId: string,
    orderId: string,
    userId: string,
    branchId?: string,
  ): Promise<{ sent: true }> {
    const order = await this.loadOrder({
      id: orderId,
      ...(branchId ? { branchId } : {}),
      branch: { restaurantId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'PAID')
      throw new BadRequestException('Only a paid order has a receipt to send');
    if (!order.branch.restaurant.digitalReceiptsEnabled)
      throw new ConflictException(
        'Digital receipts are turned off. Turn them on in Settings first.',
      );
    const row = await this.prisma.receiptEmail.findUnique({
      where: { orderId },
    });
    if (!row)
      throw new BadRequestException(
        'This order has no email address with receipt consent',
      );
    const compose = await this.templates.forBranch(order.branchId, 'RECEIPT');
    if (!compose)
      throw new ConflictException(
        'The receipt email template is turned off, so receipts are not sent. Turn it on under Settings > Email templates, then resend.',
      );
    const wait = Math.max(
      this.orderLimiter.hit(orderId, RESEND_PER_ORDER),
      this.restaurantLimiter.hit(restaurantId, RESEND_PER_RESTAURANT),
    );
    if (wait > 0)
      throw new HttpException(
        `Too many receipt emails. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (!(await this.claim(orderId, ['PENDING', 'SENT', 'FAILED', 'SKIPPED'])))
      throw new ConflictException('This receipt is already being sent');
    if (!(await this.deliver(order, row.toEmail, compose)))
      throw new BadRequestException(
        'The receipt could not be sent. Check the server email settings.',
      );
    await this.audit.record({
      userId,
      action: 'order.receipt_resent',
      entity: 'Order',
      entityId: orderId,
      metadata: { orderNumber: order.orderNumber },
    });
    return { sent: true };
  }
}
