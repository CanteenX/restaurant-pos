import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportStrategy } from '@nestjs/passport';
import type { SessionUser } from '@nventra/types';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import {
  effectivePermissions,
  permissionInclude,
} from './effective-permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  SESSION_COOKIE,
  needsRefresh,
  sessionCookieOptions,
  sessionIdleSeconds,
  type SessionPayload,
} from './session';

const cookieExtractor = (req: {
  cookies?: Record<string, string>;
}): string | null => {
  return req.cookies?.[SESSION_COOKIE] ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly idleSeconds: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
    this.idleSeconds = sessionIdleSeconds(config);
  }

  async validate(
    req: Pick<Request, 'res'>,
    payload: SessionPayload,
  ): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: permissionInclude,
    });

    // Tokens minted before tokenVersion existed carry no `tv`: read as 0.
    if (!user || !user.isActive || (payload.tv ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException('Session no longer valid');
    }

    await this.slideSession(req, payload.exp, user.id, user.tokenVersion);

    return {
      id: user.id,
      restaurantId: user.restaurantId,
      name: user.name,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions: effectivePermissions(user),
    };
  }

  /** Re-issue the cookie once past half the idle window (sliding expiry). */
  private async slideSession(
    req: Pick<Request, 'res'>,
    exp: number | undefined,
    userId: string,
    tokenVersion: number,
  ) {
    const now = Math.floor(Date.now() / 1000);
    if (!req.res || !needsRefresh(exp, now, this.idleSeconds)) return;
    const token = await this.jwt.signAsync({ sub: userId, tv: tokenVersion });
    req.res.cookie(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(this.idleSeconds * 1000),
    );
  }
}
