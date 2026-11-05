"use client";

// Online channel pieces for settings > integrations (#60): the health line on
// each delivery channel card, and the item mapping + on/off dialog.
import { AlertTriangle, CheckCircle2, CircleDashed, PauseCircle, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { Switch } from "@/components/ui/switch";
import { useBranch } from "@/hooks/use-branch";
import { useIntegrationActions, type IntegrationProviderInfo } from "@/hooks/use-integration-hub";
import { useMenuItems, useUpdateMenuItem } from "@/hooks/use-menu";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { channelHealth, itemMapPatch, type ChannelTone } from "@/lib/online-channels";

const TONE: Record<ChannelTone, { Icon: typeof CheckCircle2; className: string }> = {
  muted: { Icon: CircleDashed, className: "text-muted-foreground" },
  danger: { Icon: ShieldAlert, className: "text-destructive" },
  warning: { Icon: AlertTriangle, className: "text-warning" },
  success: { Icon: CheckCircle2, className: "text-success" },
};

/** Health in words + icon (never colour alone), last order and the retry queue. */
export function ChannelHealthLine({ p }: { p: IntegrationProviderInfo }) {
  const { t } = useI18n();
  const { retryFailed } = useIntegrationActions();
  const { note, clear, toast } = useNoteToast();
  const h = channelHealth(p.connection);
  if (!p.connection) return null;
  const { Icon, className } = h.health === "disabled" ? { Icon: PauseCircle, className: TONE.muted.className } : TONE[h.tone];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2 text-xs" data-testid={`channel-health-${p.key}`}>
      <span className={`inline-flex items-center gap-1.5 font-medium ${className}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {t(h.labelKey)}
      </span>
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">{t("settings.integrations.lastOrder")}</dt>
          <dd className="text-foreground" data-testid={`last-order-${p.key}`}>
            {h.lastOrderAt ? new Date(h.lastOrderAt).toLocaleString() : t("settings.integrations.noOrdersYet")}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">{t("settings.integrations.retriesPending")}</dt>
          <dd className="tabular-nums text-foreground">{h.retriesPending}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">{t("settings.integrations.failedUpdates")}</dt>
          <dd className={`tabular-nums ${h.failed ? "text-destructive" : "text-foreground"}`}>{h.failed}</dd>
        </div>
      </dl>
      {h.failed > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={retryFailed.isPending}
          onClick={() =>
            retryFailed.mutate(p.key, {
              onSuccess: (r) => toast.success(t("settings.integrations.retried", { count: r.requeued })),
              onError: (e) => toast.error(e instanceof ApiError ? e.message : t("settings.integrations.error")),
            })
          }
        >
          {t("settings.integrations.retryFailed")}
        </Button>
      )}
      <StatusNote note={note} onClear={clear} />
    </div>
  );
}

/**
 * Item mapping (our dish -> the platform's item id) and dish on/off for one
 * channel. Mappings are saved as a patch of what changed, merged on the
 * server; switching a dish off is the menu's own availability, applied at once.
 */
export function ChannelItemsDialog({ p, onClose }: { p: IntegrationProviderInfo; onClose: () => void }) {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const items = useMenuItems(branchId);
  const toggle = useUpdateMenuItem(branchId);
  const { patchItemMap } = useIntegrationActions();
  const { note, clear, toast } = useNoteToast();
  const stored = useMemo(() => p.connection?.itemMap ?? {}, [p.connection?.itemMap]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const fail = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);

  const rows = (items.data ?? []).filter((i) => !i.isCombo && i.name.toLowerCase().includes(query.trim().toLowerCase()));
  const patch = itemMapPatch(stored, edited);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!patch) return onClose();
    patchItemMap.mutate(
      { provider: p.key, patch },
      { onSuccess: onClose, onError: (err) => fail(err, t("settings.integrations.saveFailed")) },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings.integrations.items.title", { name: p.name })}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t("settings.integrations.items.intro", { name: p.name })}</p>
        <form onSubmit={save} className="flex min-h-0 flex-col gap-3" autoComplete="off">
          <Input
            type="search"
            aria-label={t("settings.integrations.items.search")}
            placeholder={t("settings.integrations.items.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {items.isLoading ? (
            <Skeleton className="h-40 rounded-lg" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.integrations.items.empty")}</p>
          ) : (
            <table className="block max-h-[50vh] overflow-y-auto text-sm">
              <thead className="sticky top-0 bg-popover text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-full py-1.5 pr-3 font-medium">{t("settings.integrations.items.dish")}</th>
                  <th className="py-1.5 pr-3 font-medium whitespace-nowrap">{t("settings.integrations.items.platformId", { name: p.name })}</th>
                  <th className="py-1.5 font-medium">{t("settings.integrations.items.on")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1.5 pr-3">
                      <span className="block text-foreground">{i.name}</span>
                      <span className="block text-xs text-muted-foreground">{i.category.name}</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Input
                        className="h-8 w-40"
                        maxLength={120}
                        aria-label={t("settings.integrations.items.platformIdFor", { dish: i.name })}
                        placeholder={i.id.slice(0, 10)}
                        value={edited[i.id] ?? stored[i.id] ?? ""}
                        onChange={(e) => setEdited({ ...edited, [i.id]: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5">
                      <Switch
                        aria-label={t("settings.integrations.items.onFor", { dish: i.name })}
                        checked={i.isActive}
                        disabled={toggle.isPending}
                        onCheckedChange={(isActive) =>
                          toggle.mutate(
                            { id: i.id, dto: { isActive } },
                            {
                              onSuccess: () =>
                                toast.success(
                                  t(isActive ? "settings.integrations.items.turnedOn" : "settings.integrations.items.turnedOff", { dish: i.name }),
                                ),
                              onError: (err) => fail(err, t("settings.integrations.error")),
                            },
                          )
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted-foreground">{t("settings.integrations.items.onNote")}</p>
          <StatusNote note={note} onClear={clear} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("settings.integrations.cancel")}</Button>
            <Button type="submit" disabled={patchItemMap.isPending}>
              {patchItemMap.isPending ? t("settings.integrations.saving") : t("settings.integrations.items.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
