import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArgumentsHost, BadRequestException, Body, Catch, Controller, Get, HttpCode,
  HttpException, Inject, Post, Req, Res, UnauthorizedException, UseFilters } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { controlChallengeSchema, controlFactorSchema } from '@nventra/types';
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
    return this.auth.challenge(parsed.data.email, parsed.data.password, req.socket.remoteAddress ?? 'unknown');
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
}
