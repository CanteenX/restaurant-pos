// PIN quick-switch for shared tills: keypad state, error wording and the
// list of staff who have signed in on this device. Pure and dependency-free
// so it can be unit-tested with `node --test`; the storage wrappers at the
// bottom are the only browser-touching code.

// Same bounds as pinLoginSchema in @nventra/types (kept literal here so this
// file has no runtime imports).
export const PIN_MIN = 4;
export const PIN_MAX = 8;

/** Apply one keypad press: a digit, "back" or "clear". Anything else is ignored. */
export function pressKey(pin: string, key: string): string {
  if (key === "clear") return "";
  if (key === "back") return pin.slice(0, -1);
  if (/^[0-9]$/.test(key) && pin.length < PIN_MAX) return pin + key;
  return pin;
}

export function canSubmitPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

export type PinFailureKind = "wrong" | "locked" | "server" | "offline";

/**
 * What to tell the person at the till after a failed PIN login, from the HTTP
 * status (undefined = the request never reached the server).
 * 423 = this user's PIN login is locked; 429 = this device is locked out or
 * the route throttle tripped. Both are lockouts the person must wait out.
 */
export function pinFailure(status: number | undefined, message?: string): { kind: PinFailureKind; message: string } {
  if (status === undefined) {
    return { kind: "offline", message: "Can't reach the server. Check the connection and try again." };
  }
  if (status >= 500) {
    return { kind: "server", message: "The server is having a problem right now. Please try again in a minute." };
  }
  if (status === 423 || status === 429) {
    const framework = !message || /^ThrottlerException/i.test(message);
    return {
      kind: "locked",
      message: framework ? "Too many attempts. Please wait a minute and try again." : message,
    };
  }
  return { kind: "wrong", message: message || "Incorrect PIN. Try again." };
}

/** Where a user lands after switching in (mirrors the password login page). */
export function landingPathFor(user: { roleName?: string; permissions?: readonly string[] }): string {
  const rider = user.roleName === "DELIVERY_STAFF" && user.permissions?.includes("delivery.rider");
  return rider ? "/my-deliveries" : "/dashboard";
}

// ── Device roster ──────────────────────────────────────────────────────────
// PIN login needs a user id, and the login screen has no session to list
// staff with. So the till remembers who has signed in on it (id, name, role
// only — never a PIN, token or permission list) and shows them as tiles.

export interface RosterEntry {
  id: string;
  name: string;
  roleName?: string;
}

export const ROSTER_MAX = 12;
const ROSTER_KEY = "nventra.pinRoster";

function toEntry(u: { id: string; name: string; roleName?: string }): RosterEntry {
  return u.roleName ? { id: u.id, name: u.name, roleName: u.roleName } : { id: u.id, name: u.name };
}

/** Most recent first, one row per user, at most ROSTER_MAX rows. */
export function addToRoster(list: readonly RosterEntry[], user: RosterEntry): RosterEntry[] {
  return [toEntry(user), ...list.filter((u) => u.id !== user.id)].slice(0, ROSTER_MAX);
}

export function removeFromRoster(list: readonly RosterEntry[], id: string): RosterEntry[] {
  return list.filter((u) => u.id !== id);
}

export function parseRoster(raw: string | null): RosterEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (u): u is RosterEntry =>
          typeof u === "object" && u !== null && typeof u.id === "string" && typeof u.name === "string",
      )
      .map(toEntry)
      .slice(0, ROSTER_MAX);
  } catch {
    return [];
  }
}

/** Raw stored value (a stable string, so it can be a useSyncExternalStore snapshot). */
export function readRosterRaw(): string | null {
  try {
    return window.localStorage.getItem(ROSTER_KEY);
  } catch {
    return null;
  }
}

export function readRoster(): RosterEntry[] {
  return parseRoster(readRosterRaw());
}

export function writeRoster(list: readonly RosterEntry[]): void {
  try {
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked (private mode, quota): tiles just won't be remembered.
  }
}

export function rememberDeviceUser(user: RosterEntry): void {
  writeRoster(addToRoster(readRoster(), user));
}
