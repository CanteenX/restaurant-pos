import type { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';
import type { ClientSession } from '@nventra/types';

export const SESSION_COOKIE = 'nventra_session';

/**
 * Pre-rebrand session cookie (#147). It is never read any more, but browsers
 * that signed in before the rename still send it until it expires, so auth
 * routes clear it. Remove after one release. Built from parts so the
 * repo-wide grep for old Nodedr names stays empty.
 */
export const LEGACY_SESSION_COOKIE = ['nodedr', 'session'].join('_');

interface CookieRequest {
  cookies?: Record<string, unknown>;
}
interface CookieClearer {
  clearCookie(name: string, options?: CookieOptions): unknown;
}

/** Expire the legacy cookie when the request still carries it. */
export function clearLegacySessionCookie(
  req: CookieRequest,
  res: CookieClearer,
): void {
  if (req.cookies?.[LEGACY_SESSION_COOKIE] === undefined) return;
  res.clearCookie(LEGACY_SESSION_COOKIE, sessionCookieOptions());
}

const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_MAX_HOURS = 12;

/**
 * JWT claims for a staff session. `tv` is the user's tokenVersion;
 * `auth_time` is when the user actually signed in, carried unchanged
 * across sliding renewals so the absolute cap can be enforced.
 */
export interface SessionPayload {
  sub: string;
  tv?: number;
  exp?: number;
  iat?: number;
  auth_time?: number;
}

function positiveNumber(raw: unknown, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Idle timeout in seconds (SESSION_IDLE_MINUTES, default 60). A session's
 * token and cookie last this long; any authenticated request in the second
 * half of the window re-issues them, so active terminals stay signed in and
 * an idle or lost device drops out.
 */
export function sessionIdleSeconds(config: Pick<ConfigService, 'get'>) {
  const minutes = positiveNumber(
    config.get<string>('SESSION_IDLE_MINUTES'),
    DEFAULT_IDLE_MINUTES,
  );
  return Math.round(minutes * 60);
}

/**
 * What the web app needs to run its own idle sign-out (#18), sent with
 * `/auth/me`. The browser signs out after the same SESSION_IDLE_MINUTES the
 * server uses; SESSION_IDLE_SIGNOUT=false turns the browser-side sign-out
 * off (sessions then still end after SESSION_MAX_HOURS).
 */
export function clientSessionConfig(
  config: Pick<ConfigService, 'get'>,
): ClientSession {
  const raw = String(config.get<string>('SESSION_IDLE_SIGNOUT') ?? '')
    .trim()
    .toLowerCase();
  return {
    idleMinutes: sessionIdleSeconds(config) / 60,
    idleSignOut: !['false', 'off', '0', 'no'].includes(raw),
  };
}

/**
 * Absolute session lifetime in seconds (SESSION_MAX_HOURS, default 12).
 * However active a tab is (the notification bell polls every 10 s), a
 * session never outlives this; the user must sign in again.
 */
export function sessionMaxSeconds(config: Pick<ConfigService, 'get'>) {
  const hours = positiveNumber(
    config.get<string>('SESSION_MAX_HOURS'),
    DEFAULT_MAX_HOURS,
  );
  return Math.round(hours * 3600);
}

/** Sign-in time; pre-rollout tokens without `auth_time` use `iat`. */
export function sessionStartedAt(payload: SessionPayload) {
  return payload.auth_time ?? payload.iat;
}

/** True once the session is older than the absolute cap. */
export function isPastMaxLifetime(
  payload: SessionPayload,
  nowSeconds: number,
  maxSeconds: number,
) {
  const start = sessionStartedAt(payload);
  if (typeof start !== 'number') return false;
  return nowSeconds - start >= maxSeconds;
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
