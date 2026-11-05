// Pure helpers for the online channels section of settings > integrations
// (#60): one health summary per delivery channel, and the item-map patch the
// page sends (only what changed, merged on the server).

export type ChannelHealth = "off" | "disabled" | "error" | "attention" | "waiting" | "live";
export type ChannelTone = "muted" | "danger" | "warning" | "success";

export interface ChannelConnectionLike {
  enabled: boolean;
  status: string;
  lastError: string | null;
  /** Optional so an older server without these fields still renders. */
  lastOrderAt?: string | null;
  outbox?: { pending: number; dead: number };
}

export interface ChannelHealthInfo {
  health: ChannelHealth;
  tone: ChannelTone;
  labelKey: `settings.integrations.health.${ChannelHealth}`;
  /** Platform updates queued for (re)delivery. */
  retriesPending: number;
  /** Platform updates that gave up and need "Retry failed". */
  failed: number;
  lastOrderAt: string | null;
}

const TONE: Record<ChannelHealth, ChannelTone> = {
  off: "muted",
  disabled: "muted",
  error: "danger",
  attention: "warning",
  waiting: "warning",
  live: "success",
};

function healthOf(c: ChannelConnectionLike | null, failed: number): ChannelHealth {
  if (!c) return "off";
  if (!c.enabled) return "disabled";
  if (c.status === "AUTH_EXPIRED" || c.status === "SYNC_ERROR") return "error";
  if (c.status !== "CONNECTED") return "waiting";
  // Connected, but something since then went wrong: a refused order or
  // platform updates that gave up. Pending retries alone are normal.
  if (failed > 0 || c.lastError) return "attention";
  return "live";
}

/** One summary per channel, for the status line on its card. */
export function channelHealth(c: ChannelConnectionLike | null): ChannelHealthInfo {
  const failed = c?.outbox?.dead ?? 0;
  const health = healthOf(c, failed);
  return {
    health,
    tone: TONE[health],
    labelKey: `settings.integrations.health.${health}`,
    retriesPending: c?.outbox?.pending ?? 0,
    failed,
    lastOrderAt: c?.lastOrderAt ?? null,
  };
}

export interface ItemMapPatch {
  set: Record<string, string>;
  remove: string[];
}

/**
 * What to send for an edited mapping form. Only dishes in `edited` are
 * considered, so a dish mapped elsewhere (another branch, another tab) is
 * never removed. A blank field removes that dish's mapping. Null = no change.
 */
export function itemMapPatch(stored: Record<string, string>, edited: Record<string, string>): ItemMapPatch | null {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [id, raw] of Object.entries(edited)) {
    const value = raw.trim();
    if (value === "") {
      if (id in stored) remove.push(id);
    } else if (stored[id] !== value) {
      set[id] = value;
    }
  }
  return Object.keys(set).length + remove.length === 0 ? null : { set, remove };
}
