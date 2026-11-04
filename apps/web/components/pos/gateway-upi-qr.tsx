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
import {
  gatewayQrPhase,
  gatewayQrUri,
  type GatewayAttemptView,
  type GatewayQrPhase,
} from "@/lib/gateway-qr";
import { useI18n } from "@/lib/i18n/context";

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
  onPhaseChange,
}: {
  gateway: AvailableGateway;
  branchId: string | null;
  orderId: string;
  /** What the till wants to collect now (server re-checks against the balance). */
  amount: number;
  isPartial: boolean;
  /** Lets the checkout hold its manual "Complete" while this QR can be paid. */
  onPhaseChange?: (phase: GatewayQrPhase | null) => void;
}) {
  const { t, formatCurrency } = useI18n();
  const start = useStartGatewayAttempt(branchId, orderId);
  const [created, setCreated] = useState<GatewayAttemptView | null>(null);
  const { data: attempt } = useGatewayAttempt(created);
  // One key per amount: a double tap or retry reuses the same attempt.
  const key = useRef<{ amount: number; id: string } | null>(null);
  // Until the first poll returns, judge by the attempt the server just created.
  const phase = created ? gatewayQrPhase(attempt ?? created, amount) : null;
  const uri = gatewayQrUri(attempt);
  const locked = attempt ? Number(attempt.amount) : amount;

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);
  useEffect(() => () => onPhaseChange?.(null), [onPhaseChange]);

  useEffect(() => {
    if (phase === "waiting" && uri) {
      publishDisplay({ kind: "upi", total: locked, uri, payee: gateway.name });
    } else if (phase === "stale") {
      // Never leave a QR for the old amount on the guest's screen.
      publishDisplay({ kind: "idle" });
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
          {t("pos.gatewayQr.show", { gateway: gateway.name, amount: formatCurrency(amount) })}
        </Button>
        <p className="text-[11px] text-neutral-500">{t("pos.gatewayQr.hint")}</p>
        {start.error && (
          <p className="text-xs text-red-700" role="alert">
            {start.error instanceof ApiError ? start.error.message : t("pos.gatewayQr.createFailed")}
          </p>
        )}
      </div>
    );
  }

  if (phase === "paid") {
    return (
      <div className={box} role="status" data-testid="gateway-qr-paid">
        <CheckCircle2 className="size-8 text-emerald-600" />
        <p className="text-sm font-medium text-[#17251d]">
          {t("pos.gatewayQr.paid", { amount: formatCurrency(locked) })}
        </p>
      </div>
    );
  }

  if (phase === "stale") {
    return (
      <div className={box} role="alert" data-testid="gateway-qr-stale">
        <p className="text-xs font-medium text-red-700">
          {t("pos.gatewayQr.stale", { amount: formatCurrency(amount) })}
        </p>
        <p className="text-[11px] text-neutral-500">
          {t("pos.gatewayQr.staleOld", { old: formatCurrency(locked) })}
        </p>
        <Button className="h-11" onClick={() => begin(false)} disabled={start.isPending || !(amount > 0)}>
          {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}
          {t("pos.gatewayQr.newFor", { amount: formatCurrency(amount) })}
        </Button>
      </div>
    );
  }

  if (phase === "waiting" && uri) {
    return (
      <div className={box} data-testid="gateway-qr">
        <QRCodeSVG value={uri} size={176} level="M" marginSize={1} />
        <p className="text-xs font-medium text-[#17251d]" data-testid="gateway-qr-amount">
          {t("pos.gatewayQr.scan", { amount: formatCurrency(locked), gateway: gateway.name })}
        </p>
        <p className="flex items-center gap-1 text-[11px] text-neutral-500">
          <Loader2 className="size-3 animate-spin" /> {t("pos.gatewayQr.waiting")}
        </p>
      </div>
    );
  }

  const message =
    phase === "review"
      ? t("pos.gatewayQr.review", { error: attempt?.settlementError ?? "", gateway: gateway.name })
      : phase === "expired"
        ? t("pos.gatewayQr.expired")
        : (attempt?.failureMessage ?? t("pos.gatewayQr.failed"));
  return (
    <div className={box} role="alert">
      <p className="text-xs text-red-700">{message}</p>
      {phase !== "review" && (
        <Button variant="outline" onClick={() => begin(true)} disabled={start.isPending}>
          {t("pos.gatewayQr.newQr")}
        </Button>
      )}
    </div>
  );
}
