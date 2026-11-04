// Client-side idle logout (issue #18). The server's sliding expiry
// (SESSION_IDLE_MINUTES, #17) never fires while a dashboard tab is open
// because background polling keeps renewing the cookie, so the web app
// tracks real staff input itself and signs out after the same window,
// warning shortly before. Pure logic here; the hook is use-idle-logout.ts.

/** Matches the backend default SESSION_IDLE_MINUTES. */
export const DEFAULT_IDLE_MINUTES = 60;
/** Last input time (ms since epoch), shared by every tab of this browser. */
export const ACTIVITY_STORAGE_KEY = "nventra.lastActivity";

const MINUTE = 60_000;
const MAX_WARN_MS = MINUTE;
const RECORD_THROTTLE_MS = 5_000;
// Tolerated skew for a stored timestamp ahead of this tab's clock.
const FUTURE_SKEW_MS = MINUTE;

export interface IdleConfig {
  idleMs: number;
  warnMs: number;
}

export type IdleState =
  | { phase: "active" }
  | { phase: "warning"; remainingMs: number }
  | { phase: "expired" };

/** Build the config from a minutes value (NEXT_PUBLIC_SESSION_IDLE_MINUTES). */
export function idleConfig(minutesRaw: string | undefined): IdleConfig {
  const n = Number(minutesRaw);
  const minutes = minutesRaw && Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MINUTES;
  const idleMs = Math.round(minutes * MINUTE);
  return { idleMs, warnMs: Math.min(MAX_WARN_MS, Math.round(idleMs / 4)) };
}

export function idleState(lastActivity: number, now: number, cfg: IdleConfig): IdleState {
  const idleFor = Math.max(0, now - lastActivity);
  const remainingMs = cfg.idleMs - idleFor;
  if (remainingMs <= 0) return { phase: "expired" };
  if (remainingMs <= cfg.warnMs) return { phase: "warning", remainingMs };
  return { phase: "active" };
}

/**
 * The most recent input across tabs: this tab's own, or the stored one if
 * newer. A stored value from the future is ignored so it cannot keep a
 * session alive forever.
 */
export function latestActivity(local: number, stored: string | null, now: number): number {
  const s = Number(stored);
  if (!stored || !Number.isFinite(s) || s > now + FUTURE_SKEW_MS) return local;
  return Math.max(local, s);
}

/** Write activity to storage at most every few seconds. */
export function shouldRecordActivity(lastWritten: number, now: number): boolean {
  return now - lastWritten >= RECORD_THROTTLE_MS;
}
