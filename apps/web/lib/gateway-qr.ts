// State of a "Pay by UPI QR" attempt through a payment gateway (Razorpay).
// The server owns the amount and the status; the till only renders them.

export type GatewayAttemptStatus = "CREATED" | "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED";

/** The attempt view returned by /payment-gateway endpoints. */
export interface GatewayAttemptView {
  id: string;
  provider: string;
  status: GatewayAttemptStatus;
  /** Server-computed amount, 2 decimals. This is what the QR is locked to. */
  amount: string;
  action: { type: "UPI_INTENT" | "REDIRECT" | "NONE"; value: string | null } | null;
  settled: boolean;
  settlementError: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

/**
 * `stale`: the QR is still payable at the gateway but locked to an amount the
 * till no longer wants to collect (discount, tip, split, edited amount).
 */
export type GatewayQrPhase = "starting" | "waiting" | "stale" | "paid" | "failed" | "expired" | "review";

const paise = (n: number) => Math.round(n * 100);

/** The upi:// link to draw as a QR, or null when there is none to show. */
export function gatewayQrUri(a: GatewayAttemptView | undefined): string | null {
  const v = a?.action?.type === "UPI_INTENT" ? a.action.value : null;
  return v && v.startsWith("upi://") ? v : null;
}

/**
 * Where the attempt stands. Pass `amount` (what the till wants to collect
 * now) so a QR locked to a different amount is reported as `stale` rather
 * than shown to the guest.
 */
export function gatewayQrPhase(a: GatewayAttemptView | undefined, amount?: number): GatewayQrPhase {
  if (!a) return "starting";
  // A person must reconcile it (different amount, bill closed another way).
  if (a.settlementError) return "review";
  if (a.status === "SUCCEEDED") return a.settled ? "paid" : "waiting";
  if (a.status === "FAILED") return "failed";
  if (a.status === "EXPIRED") return "expired";
  if (!gatewayQrUri(a)) return "failed";
  if (amount !== undefined && paise(amount) !== paise(Number(a.amount))) return "stale";
  return "waiting";
}

/**
 * While a gateway QR can still be paid, recording a manual UPI payment would
 * book money that never arrived and leave the gateway payment unmatched.
 */
export function gatewayQrBlocksManualUpi(phase: GatewayQrPhase | null): boolean {
  return phase === "waiting" || phase === "stale";
}

/**
 * Whether a gateway QR is still payable on the bill: either the one this till
 * has on screen, or the one the server reports open (after a reload, a table
 * switch or a method switch, when nothing is on screen any more).
 */
export function gatewayQrIsLive(
  localPhase: GatewayQrPhase | null,
  serverOpen: GatewayAttemptView | null | undefined,
): boolean {
  if (gatewayQrBlocksManualUpi(localPhase)) return true;
  return !!serverOpen && gatewayQrBlocksManualUpi(gatewayQrPhase(serverOpen));
}

const GATEWAY_NAMES: Record<string, string> = { razorpay: "Razorpay" };

/** A display name for a gateway key, also when it is no longer "available". */
export function gatewayDisplayName(provider: string): string {
  return GATEWAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

export interface GatewayHold {
  /** A gateway QR on this bill can still be paid. */
  live: boolean;
  /** Manual payment is refused until the QR is paid, expires or is overridden. */
  held: boolean;
  /** Offer "Guest is paying another way". */
  showOverride: boolean;
  /** Who the open QR is with, for the hold message. */
  gatewayName: string | null;
}

/**
 * What the checkout panel holds while a gateway QR is open. The server's open
 * attempt decides, whether or not the gateway is still offered: if Razorpay is
 * switched off or its keys stopped working with a QR open, the bill must stay
 * closable through the override (the server refuses it otherwise).
 */
export function gatewayHold(o: {
  gateway: { key: string; name: string } | null;
  localPhase: GatewayQrPhase | null;
  serverOpen: GatewayAttemptView | null | undefined;
  overridden: boolean;
  method: string;
}): GatewayHold {
  // The on-screen QR only exists while a gateway is offered.
  const live = gatewayQrIsLive(o.gateway ? o.localPhase : null, o.serverOpen);
  const held = live && !o.overridden;
  // With a gateway, UPI shows its QR; without one there is nothing to wait on here.
  const showOverride = held && (o.method !== "UPI" || !o.gateway);
  const gatewayName = !live ? null : (o.gateway?.name ?? (o.serverOpen ? gatewayDisplayName(o.serverOpen.provider) : null));
  return { live, held, showOverride, gatewayName };
}
