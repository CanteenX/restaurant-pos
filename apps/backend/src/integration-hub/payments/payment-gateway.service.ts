import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type GatewayPayment } from '@prisma/client';
import type { CreateGatewayPaymentDto } from '@nventra/types';
import { AuditService } from '../../audit/audit.service';
import { OrdersService } from '../../modules/orders/orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderContext } from '../providers/provider';
import { getProvider } from '../providers/registry';
import { decryptSecret } from '../secret-box';
import {
  GatewayError,
  isPaymentGateway,
  mapGatewayError,
  nextAttemptStatus,
  settlementRequest,
  toMinorUnits,
  type GatewayMethod,
  type PaymentGatewayProvider,
  type PaymentStatusResult,
} from './payment-gateway';

/**
 * Online payments through a gateway adapter. Owns the attempt rows and the one
 * place a confirmed gateway payment becomes an order payment (see
 * docs/PAYMENTS.md). Amounts are Decimal throughout; the adapter sees paise.
 */
@Injectable()
export class PaymentGatewayService {
  private readonly logger = new Logger(PaymentGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  private gateway(key: string): PaymentGatewayProvider {
    const p = getProvider(key);
    if (!isPaymentGateway(p)) {
      throw new NotFoundException('Unknown payment gateway');
    }
    return p;
  }

  /** Decrypted credentials of an enabled connection, or null. */
  private async context(
    restaurantId: string,
    provider: string,
  ): Promise<ProviderContext | null> {
    const c = await this.prisma.integrationConnection.findUnique({
      where: { restaurantId_provider: { restaurantId, provider } },
    });
    if (!c || !c.enabled || !c.credentialsEnc) return null;
    try {
      const credentials = JSON.parse(
        decryptSecret(c.credentialsEnc, `${restaurantId}:${provider}`),
      ) as Record<string, string>;
      return {
        restaurantId,
        externalAccountId: c.externalAccountId,
        credentials,
      };
    } catch {
      return null;
    }
  }

  view(a: GatewayPayment) {
    return {
      id: a.id,
      orderId: a.orderId,
      provider: a.provider,
      method: a.method,
      amount: a.amount.toFixed(2),
      currency: a.currency,
      status: a.status,
      externalId: a.externalId,
      action: a.action,
      failureCode: a.failureCode,
      failureMessage: a.failureMessage,
      settled: a.paymentId !== null,
      settlementError: a.settlementError,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  async createAttempt(
    user: { id: string; restaurantId: string },
    branchId: string,
    orderId: string,
    dto: CreateGatewayPaymentDto,
  ) {
    const gateway = this.gateway(dto.provider);
    const ctx = await this.context(user.restaurantId, gateway.key);
    if (!ctx) {
      throw new BadRequestException(
        `${gateway.name} is not connected - set it up under Integrations`,
      );
    }
    const prior = await this.prisma.gatewayPayment.findUnique({
      where: {
        orderId_idempotencyKey: { orderId, idempotencyKey: dto.idempotencyKey },
      },
    });
    if (prior) return this.replay(prior, branchId, dto);

    const amount = await this.chargeableAmount(branchId, orderId, dto.amount);
    let attempt: GatewayPayment;
    try {
      attempt = await this.prisma.gatewayPayment.create({
        data: {
          restaurantId: user.restaurantId,
          branchId,
          orderId,
          provider: gateway.key,
          method: dto.method,
          amount,
          idempotencyKey: dto.idempotencyKey,
          createdById: user.id,
        },
      });
    } catch (e) {
      // The same key raced itself: answer with the winner.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const won = await this.prisma.gatewayPayment.findUniqueOrThrow({
          where: {
            orderId_idempotencyKey: {
              orderId,
              idempotencyKey: dto.idempotencyKey,
            },
          },
        });
        return this.replay(won, branchId, dto);
      }
      throw e;
    }
    return this.view(await this.startAtGateway(gateway, ctx, attempt));
  }

  private replay(
    prior: GatewayPayment,
    branchId: string,
    dto: CreateGatewayPaymentDto,
  ) {
    if (prior.branchId !== branchId || prior.provider !== dto.provider) {
      throw new ConflictException(
        'This idempotency key was already used for another payment',
      );
    }
    return this.view(prior);
  }

  /** The order's balance due (or the requested part of it), as Decimal. */
  private async chargeableAmount(
    branchId: string,
    orderId: string,
    requested: number | undefined,
  ): Promise<Prisma.Decimal> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId },
      select: { status: true, acceptance: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== 'OPEN') {
      throw new BadRequestException('Order is not open for payment');
    }
    if (order.acceptance === 'PENDING') {
      throw new ConflictException(
        'This order has not been accepted yet - accept it before taking payment',
      );
    }
    const bill = await this.orders.previewBill(branchId, orderId, {});
    const balance = new Prisma.Decimal(bill.balanceDue).toDecimalPlaces(2);
    if (balance.lte(0)) throw new BadRequestException('Nothing left to pay');
    if (requested === undefined) return balance;
    const amount = new Prisma.Decimal(requested);
    if (amount.decimalPlaces() > 2) {
      throw new BadRequestException('Amount can have at most 2 decimals');
    }
    if (amount.gt(balance)) {
      throw new BadRequestException(
        `Amount exceeds the balance due (${balance.toFixed(2)})`,
      );
    }
    return amount;
  }

  private async startAtGateway(
    gateway: PaymentGatewayProvider,
    ctx: ProviderContext,
    attempt: GatewayPayment,
  ): Promise<GatewayPayment> {
    const amountMinor = toMinorUnits(attempt.amount);
    try {
      const created = await gateway.createPayment(ctx, {
        attemptId: attempt.id,
        idempotencyKey: attempt.idempotencyKey,
        amountMinor,
        currency: attempt.currency,
        method: attempt.method as GatewayMethod,
        description: `Order ${attempt.orderId}`,
      });
      if (created.amountMinor !== amountMinor) {
        throw new GatewayError(
          'INVALID_REQUEST',
          'The gateway reported a different amount',
          false,
        );
      }
      return await this.prisma.gatewayPayment.update({
        where: { id: attempt.id },
        data: {
          externalId: created.externalId,
          status: created.status,
          action: created.action as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      const g = mapGatewayError(e);
      this.logger.warn(`gateway ${gateway.key} create failed: ${g.code}`);
      return this.prisma.gatewayPayment.update({
        where: { id: attempt.id },
        data: {
          status: 'FAILED',
          failureCode: g.code,
          failureMessage: g.message.slice(0, 300),
        },
      });
    }
  }

  async get(restaurantId: string, id: string) {
    return this.view(await this.find(restaurantId, id));
  }

  private async find(restaurantId: string, id: string) {
    const a = await this.prisma.gatewayPayment.findFirst({
      where: { id, restaurantId },
    });
    if (!a) throw new NotFoundException('Payment attempt not found');
    return a;
  }

  /** Asks the gateway for the latest status (for tills polling a QR). */
  async refresh(restaurantId: string, id: string) {
    const attempt = await this.find(restaurantId, id);
    if (!attempt.externalId) return this.view(attempt);
    const gateway = this.gateway(attempt.provider);
    const ctx = await this.context(restaurantId, attempt.provider);
    if (!ctx) {
      throw new BadRequestException('The payment gateway is not connected');
    }
    let report: PaymentStatusResult;
    try {
      report = await gateway.fetchStatus(ctx, attempt.externalId);
    } catch (e) {
      const g = mapGatewayError(e);
      throw new BadRequestException(
        `Could not check the payment: ${g.message}`,
      );
    }
    return this.view(await this.applyReport(attempt, report));
  }

  /** Public webhook: any failure to verify is a plain 401. */
  async receiveWebhook(
    restaurantId: string,
    providerKey: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ) {
    const deny = () => new UnauthorizedException('Invalid webhook signature');
    const p = getProvider(providerKey);
    if (!isPaymentGateway(p)) throw deny();
    const ctx = await this.context(restaurantId, providerKey);
    if (!ctx) throw deny();
    let event: PaymentStatusResult;
    try {
      event = await p.verifyWebhook(ctx, headers, rawBody);
    } catch (e) {
      const g = mapGatewayError(e);
      if (g.code === 'INVALID_SIGNATURE') throw deny();
      throw new BadRequestException(g.message);
    }
    const attempt = await this.prisma.gatewayPayment.findFirst({
      where: {
        restaurantId,
        provider: providerKey,
        externalId: event.externalId,
      },
    });
    // Not ours (or already deleted with its order): acknowledge, do nothing,
    // but leave a trace - a create that timed out may still have charged.
    if (!attempt) {
      this.logger.warn(
        `gateway ${providerKey} webhook for unknown payment ${event.externalId} (${event.status}) ignored`,
      );
      return { ok: true, ignored: true };
    }
    const after = await this.applyReport(attempt, event);
    return {
      ok: true,
      status: after.status,
      settled: after.paymentId !== null,
    };
  }

  /**
   * Moves the attempt to the reported status, then settles it if it has
   * succeeded and is not settled yet. Safe to run any number of times.
   */
  private async applyReport(
    attempt: GatewayPayment,
    report: PaymentStatusResult,
  ): Promise<GatewayPayment> {
    let current = attempt;
    const next = nextAttemptStatus(current.status, report.status);
    if (next) {
      if (
        next === 'SUCCEEDED' &&
        report.amountMinor !== toMinorUnits(current.amount)
      ) {
        // Already flagged: a person is on it, do not log it again.
        if (current.settlementError) return current;
        return this.flag(current, 'The gateway confirmed a different amount');
      }
      // Compare-and-set on the status we read; a concurrent report wins once.
      await this.prisma.gatewayPayment.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          status: next,
          failureCode:
            next === 'SUCCEEDED' ? null : (report.failureCode ?? null),
          failureMessage:
            next === 'SUCCEEDED'
              ? null
              : (report.failureMessage?.slice(0, 300) ?? null),
        },
      });
      current = await this.prisma.gatewayPayment.findUniqueOrThrow({
        where: { id: current.id },
      });
    }
    if (
      current.status === 'SUCCEEDED' &&
      !current.paymentId &&
      !current.settlementError
    ) {
      return this.settle(current);
    }
    return current;
  }

  private async settle(attempt: GatewayPayment): Promise<GatewayPayment> {
    const req = settlementRequest({
      ...attempt,
      method: attempt.method as GatewayMethod,
    });
    let error: string | null = null;
    try {
      await this.orders.checkout(
        attempt.branchId,
        attempt.orderId,
        attempt.createdById,
        req,
      );
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      error = e.message;
    }
    // Whoever created it, the payment row keyed on this attempt is the truth:
    // a concurrent settle that lost the race still finds it here.
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: attempt.orderId, clientRequestId: req.requestId },
      select: { id: true },
    });
    if (!payment) return this.flag(attempt, error ?? 'Settlement failed');
    await this.prisma.gatewayPayment.updateMany({
      where: { id: attempt.id, paymentId: null },
      data: { paymentId: payment.id, settledAt: new Date() },
    });
    const settled = await this.prisma.gatewayPayment.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    await this.audit.record({
      userId: attempt.createdById,
      action: 'payment.gateway_settled',
      entity: 'Order',
      entityId: attempt.orderId,
      metadata: {
        attemptId: attempt.id,
        provider: attempt.provider,
        externalId: attempt.externalId,
        amount: attempt.amount.toFixed(2),
      },
    });
    return settled;
  }

  /** The money moved at the gateway but the order could not take it: needs a person. */
  private async flag(
    attempt: GatewayPayment,
    reason: string,
  ): Promise<GatewayPayment> {
    this.logger.error(`gateway attempt ${attempt.id} unsettled: ${reason}`);
    const row = await this.prisma.gatewayPayment.update({
      where: { id: attempt.id },
      data: { settlementError: reason.slice(0, 300) },
    });
    await this.audit.record({
      userId: attempt.createdById,
      action: 'payment.gateway_unsettled',
      entity: 'Order',
      entityId: attempt.orderId,
      metadata: { attemptId: attempt.id, reason },
    });
    return row;
  }
}
