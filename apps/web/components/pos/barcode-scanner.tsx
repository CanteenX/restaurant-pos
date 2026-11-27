"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuItem } from "@/hooks/use-menu";
import { findBarcodeMatch } from "@/lib/barcode-scan";
import { useI18n } from "@/lib/i18n/context";

export function BarcodeScanner({ branchId, disabled, onSelect }: {
  branchId: string | null;
  disabled: boolean;
  onSelect: (item: MenuItem) => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(true);
  const inFlight = useRef(false);
  const disabledRef = useRef(disabled);
  useLayoutEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => {
    current.current = true;
    return () => { current.current = false; };
  }, []);

  async function scan() {
    if (!branchId || disabled || inFlight.current) return;
    const input = code;
    if (!input || input.length > 128 || /[\x00-\x1f\x7f]/.test(input)) {
      setMessage(t("pos.scan.invalid"));
      return;
    }
    if (!navigator.onLine) {
      setMessage(t("pos.scan.offline"));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      // Fetch the complete menu for this branch each time; do not use a stale cache.
      const response = await fetch(`/api/v1/menu/items?branchId=${encodeURIComponent(branchId)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Menu lookup failed");
      const items: MenuItem[] = await response.json();
      if (!current.current || disabledRef.current) return;
      const result = findBarcodeMatch(input, items);
      if (result.kind === "match") {
        onSelect(result.item);
        setCode("");
        setMessage(t("pos.scan.selected", { name: result.item.name }));
      } else if (result.kind === "duplicate") {
        setMessage(t("pos.scan.duplicate"));
      } else {
        setMessage(t("pos.scan.missing"));
      }
    } catch {
      if (current.current) setMessage(t("pos.scan.unavailable"));
    } finally {
      inFlight.current = false;
      if (current.current) setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="pos-barcode" className="text-sm font-medium">{t("pos.scan.label")}</label>
      <input
        id="pos-barcode"
        className="h-11 rounded-md border border-input bg-background px-3 text-sm"
        value={code}
        maxLength={128}
        disabled={!branchId || disabled || busy}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void scan();
          }
        }}
        placeholder={t("pos.scan.placeholder")}
      />
      <p role="status" className="text-sm text-muted-foreground">{busy ? t("pos.scan.checking") : message || t("pos.scan.ready")}</p>
    </div>
  );
}
