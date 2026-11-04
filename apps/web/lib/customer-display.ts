// Mirrors the POS cart to a second screen (a customer-facing display).
// Same-device fast path: BroadcastChannel (another window of this browser).
// Cross-device: when a pairing code is set, the till also publishes through
// the Socket.IO realtime channel (see `startDisplayLink`) and the display
// joins the same code's room on the server.
import { io, type Socket } from "socket.io-client";
import {
  DISPLAY_CODE_ALPHABET,
  displayCodeSchema,
  displayStateSchema,
} from "@nventra/types";
import { resolveWsUrl } from "./ws-url.ts";

export interface DisplayLine {
  name: string;
  quantity: number;
  total: number;
}

export type DisplayState =
  | { kind: "idle" }
  | { kind: "cart"; lines: DisplayLine[]; subtotal: number }
  | { kind: "upi"; total: number; uri: string; payee: string }
  | { kind: "paid"; total: number; method?: string };

const CHANNEL = "orderrestro-customer-display";

export function publishDisplay(state: DisplayState) {
  lastState = state;
  if (link?.socket.connected) link.socket.emit("display.publish", { code: link.code, state });
  if (typeof BroadcastChannel === "undefined") return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(state);
  ch.close();
}

export function subscribeDisplay(onState: (s: DisplayState) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<DisplayState>) => onState(e.data);
  return () => ch.close();
}

export function generatePairCode(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => DISPLAY_CODE_ALPHABET[b % DISPLAY_CODE_ALPHABET.length]).join("");
}

export function normalizePairCode(input: string): string | null {
  const r = displayCodeSchema.safeParse(input);
  return r.success ? r.data : null;
}

export type PairingParams =
  | { kind: "none" }
  | { kind: "ok"; code: string; branchId: string }
  | { kind: "invalid" };

/** Reads ?code=&branch= from a URL query string. Any pairing param that is present but unusable is "invalid". */
export function parsePairingParams(search: string): PairingParams {
  const q = new URLSearchParams(search);
  const rawCode = q.get("code");
  const branchId = q.get("branch");
  if (rawCode === null && branchId === null) return { kind: "none" };
  const code = normalizePairCode(rawCode ?? "");
  if (!code || !branchId) return { kind: "invalid" };
  return { kind: "ok", code, branchId };
}

export function parseDisplayState(input: unknown): DisplayState | null {
  const r = displayStateSchema.safeParse(input);
  return r.success ? (r.data as DisplayState) : null;
}

// ---- cross-device link (Socket.IO) ----------------------------------------
let link: { socket: Socket; code: string } | null = null;
let lastState: DisplayState = { kind: "idle" };

/** Till side: also relay every published state to the paired display. */
export function startDisplayLink(branchId: string, code: string): () => void {
  stopDisplayLink();
  const socket = io(resolveWsUrl(), { query: { branchId }, withCredentials: true });
  link = { socket, code };
  // Re-send the current screen whenever the socket (re)connects.
  socket.on("connect", () => socket.emit("display.publish", { code, state: lastState }));
  return stopDisplayLink;
}

export function stopDisplayLink() {
  link?.socket.disconnect();
  link = null;
}

interface JoinSocket {
  connected: boolean;
  emit(event: "display.join", body: { code: string }, ack: (r: { ok?: boolean }) => void): unknown;
}

const JOIN_RETRY_MS = 3000;

/**
 * The server only lets a display join a code a till in this branch has
 * already issued (published under), so keep asking until the till is up.
 */
export function joinDisplayRoom(
  socket: JoinSocket,
  code: string,
  onResult: (ok: boolean) => void,
  schedule: (fn: () => void) => void = (fn) => void setTimeout(fn, JOIN_RETRY_MS),
) {
  const attempt = () => {
    if (!socket.connected) return;
    socket.emit("display.join", { code }, (r) => {
      const ok = r?.ok === true;
      onResult(ok);
      if (!ok) schedule(attempt);
    });
  };
  attempt();
}

/** Display side: join the till's code room; auto-rejoins after reconnects. */
export function subscribeDisplayRemote(
  branchId: string,
  code: string,
  onState: (s: DisplayState) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  const socket = io(resolveWsUrl(), { query: { branchId }, withCredentials: true });
  socket.on("connect", () => {
    joinDisplayRoom(socket, code, (ok) => onStatus?.(ok));
  });
  socket.on("disconnect", () => onStatus?.(false));
  socket.on("display.state", (raw: unknown) => {
    const s = parseDisplayState(raw);
    if (s) onState(s);
  });
  return () => socket.disconnect();
}
