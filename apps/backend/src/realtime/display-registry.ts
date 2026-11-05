// In-memory bookkeeping for the customer-display relay (see
// realtime.gateway.ts). A pairing code is "issued" by the first till that
// publishes under it and stays owned by that till's USER while any of that
// user's sockets holds it. Keying ownership by user (not socket id) lets a
// till that reconnects after a Wi-Fi blip reclaim its code at once, before
// the server has reaped the dead socket, while another account in the same
// branch still cannot hijack the guest's screen with a fake "paid" or a
// rogue UPI QR. A display can only join a code a till is showing right now.
// Single-process state is fine: the backend runs as one instance per site.

export const DISPLAY_RATE_LIMIT = 40;
export const DISPLAY_RATE_WINDOW_MS = 10_000;

export type ClaimResult = 'ok' | 'code-in-use';
export type DisplayBudget = 'publish' | 'join';

interface Owner {
  userId: string;
  sockets: Set<string>;
}

export class DisplayRegistry {
  private readonly owners = new Map<string, Owner>(); // room -> owner
  private readonly claims = new Map<string, string>(); // socket id -> room
  private readonly states = new Map<string, unknown>(); // room -> last state
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  claim(room: string, socketId: string, userId: string): ClaimResult {
    const owner = this.owners.get(room);
    if (owner && owner.userId !== userId) return 'code-in-use';
    const previous = this.claims.get(socketId);
    if (previous && previous !== room) this.dropSocket(previous, socketId);
    if (owner) owner.sockets.add(socketId);
    else this.owners.set(room, { userId, sockets: new Set([socketId]) });
    this.claims.set(socketId, room);
    return 'ok';
  }

  isIssued(room: string): boolean {
    return this.owners.has(room);
  }

  /** Latest validated state of an issued code, for a display that joins late. */
  remember(room: string, state: unknown) {
    if (this.owners.has(room)) this.states.set(room, state);
  }

  lastState(room: string): unknown {
    return this.states.get(room);
  }

  /** Fixed-window limit per socket, with separate publish and join budgets. */
  allow(
    socketId: string,
    budget: DisplayBudget,
    now: number = Date.now(),
  ): boolean {
    const key = `${socketId}:${budget}`;
    const w = this.windows.get(key);
    if (!w || now - w.start >= DISPLAY_RATE_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= DISPLAY_RATE_LIMIT) return false;
    w.count += 1;
    return true;
  }

  release(socketId: string) {
    const room = this.claims.get(socketId);
    if (room) this.dropSocket(room, socketId);
    this.claims.delete(socketId);
    this.windows.delete(`${socketId}:publish`);
    this.windows.delete(`${socketId}:join`);
  }

  private dropSocket(room: string, socketId: string) {
    const owner = this.owners.get(room);
    if (!owner) return;
    owner.sockets.delete(socketId);
    if (owner.sockets.size > 0) return;
    this.owners.delete(room);
    this.states.delete(room);
  }
}
