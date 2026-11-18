// Content-Security-Policy for admin HTML responses (#255).
//
// Trade-off: Next injects small inline bootstrap/hydration scripts into every
// HTML page, and a strict script-src would need a per-request nonce, which in
// turn forces every route to render dynamically (no static prerender) and
// breaks hydration whenever a page is served without one. This app has no
// middleware, so the policy keeps 'unsafe-inline' for script-src and
// style-src (React inline style attributes also need it for styles) and
// gets its value from the rest: nothing loads from another origin, no
// plugins, no framing, no base/form hijacking. Revisit with a nonce proxy
// if inline-script XSS becomes the main concern.
export interface CspOptions {
  dev: boolean;
  /** NEXT_PUBLIC_WS_URL when the realtime server is on another origin. */
  wsUrl?: string;
}

function realtimeOrigins(wsUrl: string | undefined): string[] {
  if (!wsUrl) return [];
  try {
    const u = new URL(wsUrl);
    // socket.io accepts http(s) and ws(s) URLs; allow both scheme families for the host.
    const secure = u.protocol === "https:" || u.protocol === "wss:";
    if (!secure && u.protocol !== "http:" && u.protocol !== "ws:") return [];
    return [`${secure ? "https:" : "http:"}//${u.host}`, `${secure ? "wss:" : "ws:"}//${u.host}`];
  } catch {
    return [];
  }
}

export function buildContentSecurityPolicy({ dev, wsUrl }: CspOptions): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'unsafe-eval' is only for React's dev-time stack reconstruction / HMR.
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    // /_next/image and /api/uploads are same-origin; blob:/data: are used by
    // previews and QR codes; OSM tiles feed the delivery map.
    "img-src": ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
    "font-src": ["'self'", "data:"],
    // fetch, socket.io long-polling (/socket.io) and the uploads proxy are same-origin.
    "connect-src": ["'self'", ...realtimeOrigins(wsUrl), ...(dev ? ["ws:", "wss:"] : [])],
    "media-src": ["'self'", "data:", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
