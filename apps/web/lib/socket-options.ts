// Build-time socket.io transport selection (#254).
//
// NEXT_PUBLIC_SOCKET_TRANSPORTS is a comma list of "polling" and/or
// "websocket". Unset (or anything invalid) keeps socket.io's own default:
// long-polling first, then upgrade to WebSocket. Hosts that cannot proxy
// WebSocket upgrades (e.g. Vercel rewrites) set it to "polling": the client then
// never attempts the upgrade, so there is no failed-upgrade noise.
export type SocketTransport = "polling" | "websocket";

export interface TransportConfig {
  transports: SocketTransport[];
  upgrade: boolean;
}

const VALID: readonly string[] = ["polling", "websocket"];
const DEFAULT_TRANSPORTS: SocketTransport[] = ["polling", "websocket"];

export function parseSocketTransports(raw: string | undefined): TransportConfig {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0 || !items.every((i) => VALID.includes(i))) {
    return { transports: [...DEFAULT_TRANSPORTS], upgrade: true };
  }
  const transports = [...new Set(items)] as SocketTransport[];
  // Upgrading only makes sense when both transports are on offer.
  return { transports, upgrade: transports.includes("websocket") };
}

// The env var must be read as a literal `process.env.NEXT_PUBLIC_*` member so
// Next inlines it into the client bundle at build time.
export function socketOptions(branchId: string, rawTransports = process.env.NEXT_PUBLIC_SOCKET_TRANSPORTS) {
  return {
    query: { branchId },
    withCredentials: true,
    ...parseSocketTransports(rawTransports),
  };
}
