"use client";

import { Fragment, useState, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useWebhookActions, useWebhookDeliveries, useWebhookEvents, useWebhooks } from "@/hooks/use-webhooks";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

// Inline markup helper for translated strings.
function rich(text: string, tags: Record<string, (children: string) => ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    out.push(<Fragment key={at}>{tags[m[1]]?.(m[2]) ?? m[2]}</Fragment>);
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function Deliveries({ id }: { id: string }) {
  const { t, plural } = useI18n();
  const { data } = useWebhookDeliveries(id);
  if (!data) return <Skeleton className="h-10" />;
  if (data.length === 0) return <p className="text-xs text-muted-foreground">{t("settings.webhooks.nothingSent")}</p>;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {data.map((d) => (
        <li key={d.id} className="flex flex-wrap justify-between gap-2">
          <span className="font-mono text-foreground">{d.event}</span>
          <span
            className={cn(
              d.status === "SUCCESS" && "text-success",
              d.status === "FAILED" && "text-destructive",
              d.status === "PENDING" && "text-muted-foreground",
            )}
          >
            {d.status.toLowerCase()} · {plural("settings.webhooks.attempts", d.attempts)}
            {d.lastError && ` · ${d.lastError}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function WebhooksPage() {
  const { t } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("settings.webhooks.error"));
  const { data: hooks, isLoading } = useWebhooks();
  const { data: allEvents } = useWebhookEvents();
  const { create, setActive, remove, test } = useWebhookActions();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["order.paid"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const toggle = (e: string) => setEvents(events.includes(e) ? events.filter((x) => x !== e) : [...events, e]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.webhooks.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.webhooks.subtitle")}</p>
      </div>
      <SettingsTabs />

      <Card className="flex max-w-3xl flex-col gap-4 p-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.webhooks.card.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.webhooks.card.desc")}
          </p>
        </div>

        {secret && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
            <p className="font-medium text-foreground">{t("settings.webhooks.secret.title")}</p>
            <p className="mt-1 select-all break-all font-mono text-xs">{secret}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(secret).then(() => toast.success(t("settings.webhooks.copied")))}>
                {t("settings.webhooks.copy")}
              </Button>
              <Button size="sm" onClick={() => setSecret(null)}>{t("settings.webhooks.done")}</Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Input placeholder={t("settings.webhooks.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder={t("settings.webhooks.descPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            {allEvents?.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => toggle(e)}
                className={cn(
                  "rounded-full border px-3 py-1 font-mono text-xs",
                  events.includes(e) ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <div>
            <Button
              disabled={!url.trim() || events.length === 0 || create.isPending}
              onClick={() =>
                create.mutate(
                  { url: url.trim(), events, description: description.trim() || undefined },
                  {
                    onSuccess: (r) => {
                      setSecret(r.secret);
                      setUrl("");
                      setDescription("");
                    },
                    onError: (e) => toast.error(errMsg(e)),
                  },
                )
              }
            >
              {t("settings.webhooks.add")}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="flex max-w-3xl flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : hooks && hooks.length > 0 ? (
          hooks.map((h) => (
            <div key={h.id} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className={cn("truncate font-mono text-sm", !h.isActive && "text-muted-foreground line-through")}>{h.url}</p>
                  <p className="text-xs text-muted-foreground">{h.events.join(", ")}{h.description && ` · ${h.description}`}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate(h.id, {
                        onSuccess: (r) =>
                          r.status === "SUCCESS"
                            ? toast.success(t("settings.webhooks.receiverAnswered", { code: r.lastStatusCode ?? "" }))
                            : toast.error(r.lastError ?? t("settings.webhooks.testRejected")),
                        onError: (e) => toast.error(errMsg(e)),
                      })
                    }
                  >
                    {t("settings.webhooks.sendTest")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setOpen(open === h.id ? null : h.id)}>{t("settings.webhooks.log")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setActive.mutate({ id: h.id, isActive: !h.isActive })}>
                    {h.isActive ? t("settings.webhooks.pause") : t("settings.webhooks.resume")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => confirm(t("settings.webhooks.deleteConfirm")) && remove.mutate(h.id)}>{t("settings.webhooks.delete")}</Button>
                </div>
              </div>
              {open === h.id && <Deliveries id={h.id} />}
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("settings.webhooks.empty")}</p>
        )}
      </Card>

      <Card className="max-w-3xl p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("settings.webhooks.verify.title")}</p>
        <p className="mt-1">
          {rich(t("settings.webhooks.verify.body"), { code: (text) => <code>{text}</code> })}
        </p>
      </Card>
    </div>
  );
}
