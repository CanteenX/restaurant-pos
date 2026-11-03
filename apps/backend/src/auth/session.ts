import type { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'nventra_session';

const DEFAULT_IDLE_MINUTES = 60;

/** JWT claims for a staff session. `tv` is the user's tokenVersion. */
export interface SessionPayload {
  sub: string;
  tv?: number;
  exp?: number;
}

/**
 * Idle timeout in seconds (SESSION_IDLE_MINUTES, default 60). A session's
 * token and cookie last this long; any authenticated request in the second
 * half of the window re-issues them, so active terminals stay signed in and
 * an idle or lost device drops out.
 */
export function sessionIdleSeconds(config: Pick<ConfigService, 'get'>) {
  const raw = Number(config.get<string>('SESSION_IDLE_MINUTES'));
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MINUTES;
  return Math.round(minutes * 60);
}

/** True once less than half of the idle window is left on the token. */
export function needsRefresh(
  exp: number | undefined,
  nowSeconds: number,
  idleSeconds: number,
) {
  if (typeof exp !== 'number') return false;
  return exp - nowSeconds < idleSeconds / 2;
}

// A `Secure` cookie is silently dropped by every browser on a plain
// `http://` origin — including the default `http://<lan-ip>:1995` this app
// is normally reached at. Default to false; opt in explicitly via
// COOKIE_SECURE once the app is actually served over HTTPS (see README).
function isCookieSecure(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}

export function sessionCookieOptions(maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isCookieSecure(),
    ...(maxAgeMs === undefined ? {} : { maxAge: maxAgeMs }),
  };
}
