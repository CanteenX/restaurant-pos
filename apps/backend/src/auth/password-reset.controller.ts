import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  type PasswordResetConfirmDto,
  type PasswordResetRequestDto,
} from '@nventra/types';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PasswordResetService } from './password-reset.service';

/** Public "forgot password" routes (#224). No session needed. */
@ApiTags('auth')
@Controller('v1/auth/password-reset')
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  /** Lets the login page decide whether to show "Forgot password?". */
  @Get('enabled')
  enabled() {
    return { enabled: this.resets.isAvailable() };
  }

  // Same answer for every address; also limited per IP and per account in
  // the service (see PasswordResetService.request).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('request')
  @HttpCode(202)
  request(
    @Body(new ZodValidationPipe(passwordResetRequestSchema))
    body: PasswordResetRequestDto,
    @Req() req: Request,
  ) {
    return this.resets.request(body.email, req.ip ?? 'unknown');
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('confirm')
  @HttpCode(200)
  confirm(
    @Body(new ZodValidationPipe(passwordResetConfirmSchema))
    body: PasswordResetConfirmDto,
  ) {
    return this.resets.confirm(body.token, body.password);
  }
}
