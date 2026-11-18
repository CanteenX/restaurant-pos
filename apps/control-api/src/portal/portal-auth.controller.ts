import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException, UseFilters } from '@nestjs/common';
import { controlEmptyBody } from '@nventra/types';
import type { z } from 'zod';
import { StaffExceptionFilter } from '../staff/staff.controller.js';
import { PortalAuth } from './portal-auth.js';
import { activationInput, loginInput, portalCookie, portalSetCookie } from './portal-identity-policy.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

export function portalTokenFromRequest(req: IncomingMessage) {
  const token = portalCookie(req.headers.cookie);
  if (!token) throw new UnauthorizedException();
  return token;
}

@Controller('portal')
@UseFilters(StaffExceptionFilter)
export class PortalAuthController {
  constructor(@Inject(PortalAuth) private readonly auth: PortalAuth) {}

  @Post('activate') @HttpCode(200)
  async activate(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    const { code, password } = input(activationInput, body);
    const { token, principal } = await this.auth.activate(code, password, req.socket.remoteAddress ?? 'unknown');
    res.setHeader('Set-Cookie', portalSetCookie(token));
    return principal;
  }

  @Post('session') @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    const { email, password } = input(loginInput, body);
    const { token, principal } = await this.auth.login(email, password, req.socket.remoteAddress ?? 'unknown');
    res.setHeader('Set-Cookie', portalSetCookie(token));
    return principal;
  }

  @Get('session')
  session(@Req() req: IncomingMessage) {
    return this.auth.withSession(portalTokenFromRequest(req), (_tx, principal) => Promise.resolve(principal));
  }

  @Post('logout') @HttpCode(200)
  async logout(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse) {
    input(controlEmptyBody, body ?? {});
    await this.auth.logout(portalTokenFromRequest(req));
    res.setHeader('Set-Cookie', portalSetCookie());
    return { loggedOut: true };
  }
}
