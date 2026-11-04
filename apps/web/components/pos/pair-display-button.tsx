"use client";

import { MonitorSmartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { generatePairCode, startDisplayLink, stopDisplayLink } from "@/lib/customer-display";

// Pairs this till with a customer display on ANOTHER device: shows a code, a
// link and a QR; opening the link on a tablet signed in to the same branch
// mirrors the cart there. Cleared when the till page closes.
export function PairDisplayButton({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [code, setCode] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!branchId || !code) return;
    startDisplayLink(branchId, code);
    return stopDisplayLink;
  }, [branchId, code]);

  if (!branchId) return null;
  const url =
    code && typeof window !== "undefined"
      ? `${window.location.origin}/customer-display?code=${code}&branch=${encodeURIComponent(branchId)}`
      : "";

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          if (!code) setCode(generatePairCode());
          setOpen((o) => !o);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <MonitorSmartphone className="h-3.5 w-3.5" />
        {code ? t("pos.pairDisplay.paired", { code }) : t("pos.pairDisplay.pair")}
      </button>
      {open && code && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-border bg-background p-4 shadow-lg">
          <p className="text-xs text-muted-foreground">{t("pos.pairDisplay.instructions")}</p>
          <div className="my-3 flex justify-center rounded-lg bg-white p-2">
            <QRCodeSVG value={url} size={160} />
          </div>
          <p className="break-all text-[11px] text-muted-foreground">{url}</p>
          <button
            type="button"
            className="mt-3 text-xs text-destructive underline"
            onClick={() => {
              setCode(null);
              setOpen(false);
            }}
          >
            {t("pos.pairDisplay.unpair")}
          </button>
        </div>
      )}
    </div>
  );
}
