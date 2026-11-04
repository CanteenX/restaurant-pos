// In-memory bookkeeping for the customer-display relay (see
// realtime.gateway.ts). A pairing code is "issued" by the first till socket
// that publishes under it and stays owned by that socket until it
// disconnects or switches code, so another socket in the same branch cannot
// hijack the guest's screen with a fake "paid" or a rogue UPI QR, and a
// display can only join a code a till is actually showing right now.
// Single-process state is fine: the backend runs as one instance per site.

export const DISPLAY_RATE_LIMIT = 40;
export const DISPLAY_RATE_WINDOW_MS = 10_000;

export type ClaimResult = 'ok' | 'code-in-use';

export class DisplayRegistry {
  private readonly owners = new Map<string, string>(); // room -> socket id
  private readonly claims = new Map<string, string>(); // socket id -> room
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  claim(room: string, socketId: string): ClaimResult {
    const owner = this.owners.get(room);
    if (owner && owner !== socketId) return 'code-in-use';
    const previous = this.claims.get(socketId);
    if (previous && previous !== room) this.owners.delete(previous);
    this.owners.set(room, socketId);
    this.claims.set(socketId, room);
    return 'ok';
  }

  isIssued(room: string): boolean {
    return this.owners.has(room);
  }

  /** Fixed-window limit on display events per socket. */
  allow(socketId: string, now: number = Date.now()): boolean {
    const w = this.windows.get(socketId);
    if (!w || now - w.start >= DISPLAY_RATE_WINDOW_MS) {
      this.windows.set(socketId, { start: now, count: 1 });
      return true;
    }
    if (w.count >= DISPLAY_RATE_LIMIT) return false;
    w.count += 1;
    return true;
  }

  release(socketId: string) {
    const room = this.claims.get(socketId);
    if (room && this.owners.get(room) === socketId) this.owners.delete(room);
    this.claims.delete(socketId);
    this.windows.delete(socketId);
  }
}
