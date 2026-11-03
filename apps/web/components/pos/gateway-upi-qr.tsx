"use client";

import { CheckCircle2, Loader2, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useGatewayAttempt,
  useStartGatewayAttempt,
  type AvailableGateway,
} from "@/hooks/use-payment-gateway";
import { ApiError } from "@/lib/api";
import { publishDisplay } from "@/lib/customer-display";
import { formatCurrency } from "@/lib/format";
import { gatewayQrPhase, gatewayQrUri, type GatewayAttemptView } from "@/lib/gateway-qr";

/**
 * "Pay by UPI QR" through a connected gateway: the server creates a dynamic,
 * single-use QR locked to the amount it computed, then this polls until the
 * gateway confirms and the server settles the bill.
 */
export function GatewayUpiQr({
  gateway,
  branchId,
  orderId,
  amount,
  isPartial,
}: {
  gateway: AvailableGateway;
  branchId: string | null;
  orderId: string;
  /** What the till wants to collect now (server re-checks against the balance). */
  amount: number;
  isPartial: boolean;
}) {
  const start = useStartGatewayAttempt(branchId, orderId);
  const [created, setCreated] = useState<GatewayAttemptView | null>(null);
  const { data: attempt } = useGatewayAttempt(created);
  // One key per amount: a double tap or retry reuses the same attempt.
  const key = useRef<{ amount: number; id: string } | null>(null);
  const phase = created ? gatewayQrPhase(attempt) : null;
  const uri = gatewayQrUri(attempt);
  const locked = attempt ? Number(attempt.amount) : amount;

  useEffect(() => {
    if (phase === "waiting" && uri) {
      publishDisplay({ kind: "upi", total: locked, uri, payee: gateway.name });
    }
  }, [phase, uri, locked, gateway.name]);

  const begin = (fresh: boolean) => {
    if (fresh || key.current?.amount !== amount) key.current = { amount, id: crypto.randomUUID() };
    start.mutate(
      {
        provider: gateway.key,
        idempotencyKey: key.current.id,
        ...(isPartial ? { amount } : {}),
      },
      { onSuccess: setCreated },
    );
  };

  const box = "flex w-full flex-col items-center gap-2 text-center";

  if (!created) {
    return (
      <div className={box}>
        <Button className="h-11" onClick={() => begin(false)} disabled={start.isPending || !(amount > 0)}>
          {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
          Show {gateway.name} UPI QR · {formatCurrency(amount)}
        </Button>
        <p className="text-[11px] text-neutral-500">Single-use QR locked to the exact amount; the bill closes itself once paid.</p>
        {start.error && (
          <p className="text-xs text-red-700" role="alert">
            {start.error instanceof ApiError ? start.error.message : "Could not create the QR"}
          </p>
        )}
      </div>
    );
  }

  if (phase === "paid") {
    return (
      <div className={box} role="status" data-testid="gateway-qr-paid">
        <CheckCircle2 className="size-8 text-emerald-600" />
        <p className="text-sm font-medium text-[#17251d]">Payment received · {formatCurrency(locked)}</p>
      </div>
    );
  }

  if (phase === "waiting" && uri) {
    return (
      <div className={box} data-testid="gateway-qr">
        <QRCodeSVG value={uri} size={176} level="M" marginSize={1} />
        <p className="text-xs font-medium text-[#17251d]" data-testid="gateway-qr-amount">
          Scan with any UPI app · {formatCurrency(locked)} locked by {gateway.name}
        </p>
        <p className="flex items-center gap-1 text-[11px] text-neutral-500">
          <Loader2 className="size-3 animate-spin" /> Waiting for the payment · also on the customer display
        </p>
      </div>
    );
  }

  const message =
    phase === "review"
      ? `Money arrived but could not be put on this bill: ${attempt?.settlementError}. Check it in ${gateway.name} before refunding.`
      : phase === "expired"
        ? "This QR expired before it was paid."
        : (attempt?.failureMessage ?? "The QR could not be created.");
  return (
    <div className={box} role="alert">
      <p className="text-xs text-red-700">{message}</p>
      {phase !== "review" && (
        <Button variant="outline" onClick={() => begin(true)} disabled={start.isPending}>
          New QR
        </Button>
      )}
    </div>
  );
}
