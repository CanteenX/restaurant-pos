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

export type GatewayQrPhase = "starting" | "waiting" | "paid" | "failed" | "expired" | "review";

/** The upi:// link to draw as a QR, or null when there is none to show. */
export function gatewayQrUri(a: GatewayAttemptView | undefined): string | null {
  const v = a?.action?.type === "UPI_INTENT" ? a.action.value : null;
  return v && v.startsWith("upi://") ? v : null;
}

export function gatewayQrPhase(a: GatewayAttemptView | undefined): GatewayQrPhase {
  if (!a) return "starting";
  // A person must reconcile it (different amount, bill closed another way).
  if (a.settlementError) return "review";
  if (a.status === "SUCCEEDED") return a.settled ? "paid" : "waiting";
  if (a.status === "FAILED") return "failed";
  if (a.status === "EXPIRED") return "expired";
  return gatewayQrUri(a) ? "waiting" : "failed";
}
