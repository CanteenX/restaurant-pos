"use client";

import { useI18n } from "@/lib/i18n/context";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useSetKiosk,
  useUpdateBranchSettings,
  type BranchSettings,
} from "@/hooks/use-settings";

// Settings > Customer kiosk. The URL's token is the only credential the public
// kiosk screen has: it can read the menu and place orders, nothing else.
export function KioskCard({
  branchId,
  branch,
}: {
  branchId: string | null;
  branch: BranchSettings;
}) {
  const { t } = useI18n();
  const setKiosk = useSetKiosk(branchId);
  const update = useUpdateBranchSettings(branchId);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const url =
    branch.kioskToken && typeof window !== "undefined"
      ? `${window.location.origin}/kiosk/${branch.kioskToken}`
      : null;

  const run = (action: "enable" | "rotate" | "disable", done: string) =>
    setKiosk.mutate(action, {
      onSuccess: () => {
        toast.success(done);
        setConfirmRotate(false);
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : t("settings.kioskCard.updateFailed")),
    });
  const save = (dto: { kioskDineInEnabled?: boolean; kioskTakeawayEnabled?: boolean }) =>
    update.mutate(dto, {
      onSuccess: () => toast.success(t("settings.kioskCard.saved")),
      onError: (e) => toast.error(e instanceof Error ? e.message : t("settings.kioskCard.saveFailed")),
    });

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.kioskCard.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.kioskCard.intro")}
        </p>
      </div>

      {!branch.kioskToken ? (
        <div>
          <Button onClick={() => run("enable", t("settings.kioskCard.enabled"))} disabled={setKiosk.isPending}>
            {t("settings.kioskCard.enable")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="kiosk-url">{t("settings.kioskCard.address")}</Label>
              <div className="flex gap-2">
                <input
                  id="kiosk-url"
                  readOnly
                  value={url ?? ""}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("settings.kioskCard.copyAria")}
                  onClick={() =>
                    url &&
                    navigator.clipboard
                      .writeText(url)
                      .then(() => toast.success(t("settings.kioskCard.copied")))
                      .catch(() => toast.error(t("settings.kioskCard.copyFailed")))
                  }
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t("settings.kioskCard.openAria")}
                  onClick={() => url && window.open(url, "_blank", "noopener")}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.kioskCard.addressHint")}
              </p>
            </div>
            {url && (
              <div className="shrink-0 rounded-lg bg-white p-2" aria-label={t("settings.kioskCard.qrAria")}>
                <QRCodeSVG value={url} size={112} marginSize={1} />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="kiosk-dine-in">{t("settings.kioskCard.offerDineIn")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.kioskCard.offerDineInHint")}
              </p>
            </div>
            <Switch
              id="kiosk-dine-in"
              checked={branch.kioskDineInEnabled}
              disabled={update.isPending || (branch.kioskDineInEnabled && !branch.kioskTakeawayEnabled)}
              onCheckedChange={(v) => save({ kioskDineInEnabled: v })}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
            <Label htmlFor="kiosk-takeaway">{t("settings.kioskCard.offerTakeaway")}</Label>
            <Switch
              id="kiosk-takeaway"
              checked={branch.kioskTakeawayEnabled}
              disabled={update.isPending || (branch.kioskTakeawayEnabled && !branch.kioskDineInEnabled)}
              onCheckedChange={(v) => save({ kioskTakeawayEnabled: v })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {confirmRotate ? (
              <>
                <span className="text-sm text-foreground">
                  {t("settings.kioskCard.confirmRotate")}
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={setKiosk.isPending}
                  onClick={() => run("rotate", t("settings.kioskCard.rotated"))}
                >
                  {t("settings.kioskCard.confirmYes")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRotate(false)}>
                  {t("settings.kioskCard.cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>
                  <KeyRound className="h-4 w-4" /> {t("settings.kioskCard.createNew")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={setKiosk.isPending}
                  onClick={() => run("disable", t("settings.kioskCard.disabled"))}
                >
                  {t("settings.kioskCard.turnOff")}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
