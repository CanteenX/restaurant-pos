import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArgumentsHost, BadRequestException, Body, Catch, Controller, Get, HttpCode,
  HttpException, Inject, Param, Patch, Post, Query, Req, Res, UnauthorizedException, UseFilters } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { controlChallengeSchema, controlFactorSchema, controlStaffPage, controlStaffGrants, controlStaffId, controlEmptyBody } from '@nventra/types';
import { StaffAuth } from './staff-auth.js';

const cookieName = '__Host-control_staff';
function sessionCookie(req: IncomingMessage) {
  const value = req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(cookieName + '='));
  const token = value?.slice(cookieName.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
  return token;
}

@Catch()
class StaffExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    res.statusCode = err instanceof HttpException ? err.getStatus() : 500;
    res.end();
  }
}

@Controller('staff')
@UseFilters(StaffExceptionFilter)
export class StaffController {
  constructor(@Inject(StaffAuth) private readonly auth: StaffAuth) {}

  @Post('session/challenge') @HttpCode(200)
  challenge(@Body() body: unknown, @Req() req: IncomingMessage) {
    const parsed = controlChallengeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.auth.challenge(parsed.data.email, parsed.data.password, req.socket.remoteAddress ?? 'unknown', parsed.data.enrollmentProof);
  }

  private async complete(body: unknown, req: IncomingMessage, res: ServerResponse, enrollment: boolean) {
    const parsed = controlFactorSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { session, recoveryCodes } = await this.auth.factor(parsed.data.challenge, parsed.data.code,
      req.socket.remoteAddress ?? 'unknown', enrollment);
    res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
    return recoveryCodes ? { recoveryCodes } : { verified: true };
  }

  @Post('enrollment') @HttpCode(200)
  enroll(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    return this.complete(body, req, res, true);
  }

  @Post('session/verify') @HttpCode(200)
  verify(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    return this.complete(body, req, res, false);
  }

  @Get('session')
  current(@Req() req: IncomingMessage) { return this.auth.session(sessionCookie(req)); }

  @Post('session/logout') @HttpCode(200)
  async logout(@Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    await this.auth.logout(sessionCookie(req));
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    return { loggedOut: true };
  }

  @Get('users')
  list(@Req() req: IncomingMessage, @Query() query: unknown) {
    const page = controlStaffPage.safeParse(query);
    if (!page.success) throw new BadRequestException();
    return this.auth.access.list(sessionCookie(req), page.data);
  }

  @Patch('users/:id/grants')
  grants(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    const target = controlStaffId.safeParse(id), dto = controlStaffGrants.safeParse(body);
    if (!target.success || !dto.success) throw new BadRequestException();
    return this.auth.access.change(sessionCookie(req), target.data, { kind: 'grants', grants: dto.data.grants });
  }

  private revoke(req: IncomingMessage, id: string, body: unknown, kind: 'reset' | 'revoke') {
    const target = controlStaffId.safeParse(id);
    if (!target.success || !controlEmptyBody.safeParse(body === undefined ? {} : body).success) throw new BadRequestException();
    return this.auth.access.change(sessionCookie(req), target.data, { kind });
  }

  @Post('users/:id/reset-factor') @HttpCode(200)
  reset(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.revoke(req, id, body, 'reset');
  }

  @Post('users/:id/revoke-sessions') @HttpCode(200)
  revokeSessions(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.revoke(req, id, body, 'revoke');
  }
}
