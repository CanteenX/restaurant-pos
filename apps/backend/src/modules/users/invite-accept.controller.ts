import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  inviteAcceptSchema,
  inviteTokenSchema,
  type InviteAcceptDto,
  type InviteTokenDto,
} from '@nventra/types';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { StaffInviteService } from './staff-invite.service';

/**
 * Public accept-invite routes (#223). No session: the single-use token is the
 * credential. POST (not GET) so the token never sits in a URL or access log.
 */
@ApiTags('auth')
@Controller('v1/auth/invite')
export class InviteAcceptController {
  constructor(private readonly invites: StaffInviteService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('inspect')
  @HttpCode(200)
  inspect(
    @Body(new ZodValidationPipe(inviteTokenSchema)) body: InviteTokenDto,
  ) {
    return this.invites.inspect(body.token);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  @HttpCode(200)
  accept(
    @Body(new ZodValidationPipe(inviteAcceptSchema)) body: InviteAcceptDto,
  ) {
    return this.invites.accept(body.token, body.password);
  }
}
