import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  loginSchema,
  pinLoginSchema,
  registerSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  type ClientSession,
  type SessionUser,
} from '@nventra/types';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { Auth } from '../common/decorators/auth.decorator';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { SessionService } from './session.service';
import {
  SESSION_COOKIE,
  clearLegacySessionCookie,
  sessionCookieOptions,
  clientSessionConfig,
  sessionIdleSeconds,
} from './session';

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  private readonly cookieMaxAgeMs: number;
  private readonly clientSession: ClientSession;

  constructor(
    private readonly authService: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly sessions: SessionService,
    config: ConfigService,
  ) {
    this.cookieMaxAgeMs = sessionIdleSeconds(config) * 1000;
    this.clientSession = clientSessionConfig(config);
  }

  // Tighter than the app-wide default — unauthenticated and creates a full
  // restaurant + owner account, a more attractive abuse target than login.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  @UsePipes(new ZodValidationPipe(registerSchema))
  async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.register(body as never);
    this.setSessionCookie(req, res, token);
    return { user };
  }

  // Tighter than the app-wide default (see register above) — login is a
  // classic credential-stuffing/brute-force target.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, user } = await this.authService.login(body as never);
    this.setSessionCookie(req, res, token);
    return { user };
  }

  // Much tighter than login: a PIN is a short numeric secret (4-8 digits,
  // as low as 10,000 possibilities) rather than a full password, so the
  // app-wide throttle alone (300 req/min/IP) would let an attacker exhaust
  // a 4-digit PIN space in well under an hour against a known userId. This
  // caps that to 5/min/IP — the same budget register() uses for its own
  // higher-value target.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('pin-login')
  @UsePipes(new ZodValidationPipe(pinLoginSchema))
  async pinLogin(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Same cookie as password login. The service also locks per user and
    // per address on repeated failures (see AuthService.pinLogin).
    const { token, user } = await this.authService.pinLogin(
      body as never,
      req.ip ?? 'unknown',
    );
    this.setSessionCookie(req, res, token);
    return { user };
  }

  // Delete my own account; asks for the password again.
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Delete('me')
  async deleteMe(
    @CurrentUser() user: SessionUser,
    @Body() body: { password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.deleteOwnAccount(
      user.id,
      String(body?.password ?? ''),
      req.ip ?? 'unknown',
    );
    this.clearSessionCookies(req, res);
    return { ok: true };
  }

  @Post('logout')
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.clearSessionCookies(req, res);
    return { ok: true };
  }

  // "Log out of all devices": every token this user holds stops working,
  // including the one on this request.
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sessions/revoke')
  async revokeMySessions(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sessions.revokeAll(user.id);
    this.clearSessionCookies(req, res);
    return { ok: true };
  }

  // An owner/admin signs a staff member out everywhere (lost/shared device).
  @Auth('users.manage')
  @Post('sessions/revoke/:userId')
  revokeStaffSessions(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
  ) {
    return this.sessions.revokeForStaff(user, user.restaurantId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('2fa/status')
  twoFactorStatus(@CurrentUser() user: SessionUser) {
    return this.twoFactor.status(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/setup')
  twoFactorSetup(@CurrentUser() user: SessionUser) {
    return this.twoFactor.setup(user.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  @UsePipes(new ZodValidationPipe(twoFactorCodeSchema))
  twoFactorEnable(
    @CurrentUser() user: SessionUser,
    @Body() body: { code: string },
  ) {
    return this.twoFactor.enable(user.id, body.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  @UsePipes(new ZodValidationPipe(twoFactorDisableSchema))
  twoFactorDisable(
    @CurrentUser() user: SessionUser,
    @Body() body: { password: string; code: string },
    @Req() req: Request,
  ) {
    return this.twoFactor.disable(
      user.id,
      body.password,
      body.code,
      req.ip ?? 'unknown',
    );
  }

  // An owner/admin unlocks a staff member who lost their authenticator.
  @Auth('users.manage')
  @Post('2fa/reset/:userId')
  twoFactorReset(
    @CurrentUser() user: SessionUser,
    @Param('userId') userId: string,
  ) {
    return this.twoFactor.adminReset(user, user.restaurantId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(
    @CurrentUser() user: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Only the legacy cookie: the current session stays as it is.
    clearLegacySessionCookie(req, res);
    return { user, session: this.clientSession };
  }

  // Public and unauthenticated — the marketing/login page needs this before
  // anyone is signed in, to decide whether to show the full landing pitch
  // (no restaurant registered on this instance yet) or just Sign in + View
  // documentation (someone already completed setup, so this is a live
  // business instance, not an unclaimed install).
  @Get('setup-status')
  async setupStatus() {
    const isSetup = await this.authService.hasAnyRestaurant();
    return { isSetup };
  }

  private setSessionCookie(req: Request, res: Response, token: string) {
    clearLegacySessionCookie(req, res);
    res.cookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(this.cookieMaxAgeMs),
    );
  }

  private clearSessionCookies(req: Request, res: Response) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    clearLegacySessionCookie(req, res);
  }
}
