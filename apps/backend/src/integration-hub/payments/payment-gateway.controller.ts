import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  createGatewayPaymentSchema,
  type CreateGatewayPaymentDto,
  type SessionUser,
} from '@nventra/types';
import type { Request } from 'express';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PaymentGatewayService } from './payment-gateway.service';

// Taking an online payment is taking payment on a bill: the same
// `bills.print` permission as checkout. The restaurant comes from the session.
@ApiTags('payment-gateway')
@Controller('v1/payment-gateway')
export class PaymentGatewayController {
  constructor(
    private readonly svc: PaymentGatewayService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  /** Connected gateways the till can offer (e.g. "Pay by UPI QR"). */
  @Auth('bills.print')
  @Get('available')
  available(@CurrentUser() user: SessionUser) {
    return this.svc.available(user.restaurantId);
  }

  @Auth('bills.print')
  @Post('orders/:orderId/attempts')
  async create(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(createGatewayPaymentSchema))
    body: CreateGatewayPaymentDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.svc.createAttempt(user, branchId, orderId, body);
  }

  /** The bill's still-payable gateway QR, so a reloaded till can resume it. */
  @Auth('bills.print')
  @Get('orders/:orderId/attempts/open')
  async open(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('orderId') orderId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.svc.openAttempt(user.restaurantId, branchId, orderId);
  }

  @Auth('bills.print')
  @Get('attempts/:id')
  get(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.svc.get(user.restaurantId, id);
  }

  @Auth('bills.print')
  @Post('attempts/:id/refresh')
  refresh(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.svc.refresh(user.restaurantId, id);
  }
}

// Deliberately unauthenticated: the caller is the gateway. Trust comes only
// from the adapter's signature check over the exact bytes received.
@ApiTags('payment-gateway')
@Controller('v1/payment-gateway/webhook')
export class PaymentGatewayWebhookController {
  constructor(private readonly svc: PaymentGatewayService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':restaurantId/:provider')
  receive(
    @Param('restaurantId') restaurantId: string,
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    if (!req.rawBody) throw new BadRequestException('Empty body');
    return this.svc.receiveWebhook(
      restaurantId,
      provider,
      headers,
      req.rawBody.toString('utf8'),
    );
  }
}
