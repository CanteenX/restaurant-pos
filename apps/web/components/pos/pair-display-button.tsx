"use client";

import { Popover } from "@base-ui/react/popover";
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
    <Popover.Root
      open={open && !!code}
      onOpenChange={(next) => {
        if (next && !code) setCode(generatePairCode());
        setOpen(next);
      }}
    >
      <Popover.Trigger
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden="true" />
        {code ? t("pos.pairDisplay.paired", { code }) : t("pos.pairDisplay.pair")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup className="w-64 rounded-xl border border-border bg-background p-4 shadow-lg outline-none">
            <p className="text-xs text-muted-foreground">{t("pos.pairDisplay.instructions")}</p>
            <div className="my-3 flex justify-center rounded-lg bg-white p-2">
              <QRCodeSVG value={url} size={160} />
            </div>
            <p className="break-all text-[11px] text-muted-foreground">{url}</p>
            <button
              type="button"
              className="mt-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-destructive/40 px-4 text-sm font-medium text-destructive hover:bg-destructive/10"
              onClick={() => {
                setCode(null);
                setOpen(false);
              }}
            >
              {t("pos.pairDisplay.unpair")}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
