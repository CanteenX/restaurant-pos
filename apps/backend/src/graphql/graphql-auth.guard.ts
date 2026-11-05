import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import {
  findActiveIntegrationKey,
  touchIntegrationKey,
} from '../common/guards/integration-api-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { envLimit, KeyRateLimiter } from '../common/guards/key-rate-limiter';
import { buildGraphqlContext } from './graphql-context';

const INTEGRATION_PREFIX = 'ordr_ext_';

// Authenticates POST /api/v1/graphql with one of two credentials:
//  - `Authorization: Bearer ordr_ext_…` — an integration API key, the same
//    credential (and the same revoked/expired checks) as the REST API;
//  - the staff session cookie — the same JWT strategy as every @Auth route.
// Any other bearer token is refused rather than falling back to the cookie,
// so a mistyped key never silently runs as whoever is logged in.
// JSON-only bodies: a cross-site form post (text/plain, urlencoded) cannot
// ride the session cookie into a mutation.
// Then rate-limits per principal (behind the web proxy all callers share one
// IP, so the app-wide IP throttler alone cannot separate them).
@Injectable()
export class GraphqlAuthGuard implements CanActivate {
  private readonly jwt = new JwtAuthGuard();
  private readonly limiter = new KeyRateLimiter();
  private readonly limit = envLimit('GRAPHQL_LIMIT_PER_MIN', 120);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: SessionUser }>();
    if (!req.is('application/json')) {
      throw new UnsupportedMediaTypeException(
        'GraphQL requests must be POSTed as application/json',
      );
    }

    const header = req.headers.authorization;
    if (header) {
      const token = header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
      if (!token.startsWith(INTEGRATION_PREFIX)) {
        throw new UnauthorizedException(
          'Use an integration API key (Bearer ordr_ext_…) or a staff session',
        );
      }
      const key = await findActiveIntegrationKey(this.prisma, token);
      req.integrationKey = {
        id: key.id,
        restaurantId: key.restaurantId,
        branchId: key.branchId,
        scopes: key.scopes,
      };
      touchIntegrationKey(this.prisma, key.id);
    } else if (!(await this.jwt.canActivate(context))) {
      throw new UnauthorizedException('Authentication required');
    }

    const ctx = buildGraphqlContext(req);
    const retryAfter = this.limiter.hit(
      `${ctx.principal.kind}:${ctx.principal.id}`,
      this.limit,
    );
    if (retryAfter > 0) {
      http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        'Too many GraphQL requests — slow down and retry later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
