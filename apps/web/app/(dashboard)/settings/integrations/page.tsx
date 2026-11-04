"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Copy, KeyRound, Link2, PauseCircle, ShieldAlert, Webhook } from "lucide-react";
import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { Switch } from "@/components/ui/switch";
import {
  useIntegrationActions,
  useIntegrationHub,
  useIntegrationLogs,
  type IntegrationProviderInfo,
  type IntegrationStatus,
} from "@/hooks/use-integration-hub";
import { ApiError } from "@/lib/api";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";

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

// Status is always words plus an icon, never colour alone.
const STATUS: Record<IntegrationStatus, { label: TranslationKey; Icon: typeof CheckCircle2; tone: string }> = {
  NOT_CONNECTED: { label: "settings.integrations.status.NOT_CONNECTED", Icon: CircleDashed, tone: "text-muted-foreground" },
  PENDING_CONFIGURATION: { label: "settings.integrations.status.PENDING_CONFIGURATION", Icon: AlertTriangle, tone: "text-warning" },
  CONNECTED: { label: "settings.integrations.status.CONNECTED", Icon: CheckCircle2, tone: "text-success" },
  SYNC_ERROR: { label: "settings.integrations.status.SYNC_ERROR", Icon: ShieldAlert, tone: "text-destructive" },
  AUTH_EXPIRED: { label: "settings.integrations.status.AUTH_EXPIRED", Icon: ShieldAlert, tone: "text-destructive" },
  DISABLED: { label: "settings.integrations.status.DISABLED", Icon: PauseCircle, tone: "text-muted-foreground" },
};

function StatusBadge({ status }: { status: IntegrationStatus }) {
  const { t } = useI18n();
  const { label, Icon, tone } = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${tone}`}>
      <Icon className="h-4 w-4" aria-hidden />
      {t(label)}
    </span>
  );
}

const SAMPLE_PAYLOAD = `{
  "event": "order.created",
  "orderId": "ZOM-10231",
  "paymentMode": "PREPAID",
  "customer": { "name": "Asha", "phone": "9876500011" },
  "delivery": { "address": "12 MG Road", "pincode": "560001" },
  "items": [{ "name": "Paneer Tikka", "quantity": 2 }]
}`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
      {done ? t("settings.integrations.copied") : t("settings.integrations.copy")}
    </Button>
  );
}

function WebhookDetails({ p }: { p: IntegrationProviderInfo }) {
  const { t } = useI18n();
  if (!p.webhookPath) return null;
  const url = `${typeof window === "undefined" ? "" : window.location.origin}${p.webhookPath}`;
  return (
    <details className="rounded-lg border border-border bg-secondary/40 p-3 text-xs">
      <summary className="cursor-pointer font-medium text-foreground">{t("settings.integrations.webhook.summary")}</summary>
      <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
        <p>
          {t("settings.integrations.webhook.give", { name: p.name })}
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-foreground">{url}</code>
          <CopyButton text={url} label={t("settings.integrations.copyWebhookUrl")} />
        </div>
        <p>
          {rich(t("settings.integrations.webhook.send"), { code: (text) => <code>{text}</code> })}
        </p>
        <pre className="overflow-x-auto rounded bg-background p-2 text-foreground">{SAMPLE_PAYLOAD}</pre>
        <p>{rich(t("settings.integrations.webhook.orders"), { code: (text) => <code>{text}</code> })}</p>
      </div>
    </details>
  );
}

function ProviderCard({ p, onConfigure }: { p: IntegrationProviderInfo; onConfigure: () => void }) {
  const { t } = useI18n();
  const when = (s: string | null) => (s ? new Date(s).toLocaleString() : t("settings.integrations.never"));
  const { test, setEnabled, disconnect } = useIntegrationActions();
  const { note, clear, toast } = useNoteToast();
  const [showLog, setShowLog] = useState(false);
  const logs = useIntegrationLogs(showLog ? p.key : null);
  const c = p.connection;
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t("settings.integrations.error"));
  const unsupported = !p.capabilities.receiveOrders && !p.capabilities.webhooks;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[18px] font-medium text-foreground">{p.name}</h3>
          <p className="text-sm text-muted-foreground">{p.description}</p>
        </div>
        {c && (
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor={`en-${p.key}`} className="text-xs text-muted-foreground">
              {c.enabled ? t("settings.integrations.enabled") : t("settings.integrations.disabled")}
            </Label>
            <Switch
              id={`en-${p.key}`}
              checked={c.enabled}
              disabled={setEnabled.isPending}
              onCheckedChange={(enabled) => setEnabled.mutate({ provider: p.key, enabled }, { onError: fail })}
            />
          </div>
        )}
      </div>

      <StatusBadge status={c?.status ?? "NOT_CONNECTED"} />

      {unsupported && (
        <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          {t("settings.integrations.unsupported", { name: p.name, requirements: p.requirements ?? "" })}
        </p>
      )}

      <WebhookDetails p={p} />

      {c && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1.5"><dt className="text-muted-foreground">{p.accountIdLabel ?? t("settings.integrations.account")}:</dt><dd className="min-w-0 break-words text-foreground">{c.externalAccountId ?? "—"}</dd></div>
          <div className="flex gap-1.5"><dt className="text-muted-foreground">{t("settings.integrations.lastChecked")}</dt><dd className="text-foreground">{when(c.lastSyncAt)}</dd></div>
          <div className="flex gap-1.5"><dt className="text-muted-foreground">{t("settings.integrations.lastSuccess")}</dt><dd className="text-foreground">{when(c.lastSuccessAt)}</dd></div>
          {c.lastError && (
            <div className="flex gap-1.5 sm:col-span-2"><dt className="text-muted-foreground">{t("settings.integrations.lastError")}</dt><dd className="min-w-0 break-words text-destructive">{c.lastError}</dd></div>
          )}
        </dl>
      )}

      <StatusNote note={note} onClear={clear} />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onConfigure}>{c ? t("settings.integrations.configure") : t("settings.integrations.connect")}</Button>
        {c && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!c.enabled || test.isPending}
              onClick={() =>
                test.mutate(p.key, {
                  onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.warning(r.message)),
                  onError: fail,
                })
              }
            >
              {test.isPending ? t("settings.integrations.checking") : p.webhookPath ? t("settings.integrations.checkStatus") : t("settings.integrations.testConnection")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              {t("settings.integrations.activity")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={disconnect.isPending}
              onClick={() => {
                if (!confirm(t("settings.integrations.disconnectConfirm", { name: p.name }))) return;
                disconnect.mutate(p.key, { onError: fail });
              }}
            >
              {t("settings.integrations.disconnect")}
            </Button>
          </>
        )}
      </div>

      {showLog && (
        <ul className="flex max-h-48 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
          {logs.isLoading && <li className="p-2 text-muted-foreground">{t("settings.integrations.loading")}</li>}
          {logs.data?.length === 0 && <li className="p-2 text-muted-foreground">{t("settings.integrations.noActivity")}</li>}
          {logs.data?.map((l) => (
            <li key={l.id} className="flex gap-2 p-2">
              <span className="shrink-0 text-muted-foreground">{new Date(l.createdAt).toLocaleString()}</span>
              <Badge variant="secondary" className="shrink-0">{l.level}</Badge>
              <span className="min-w-0 break-words text-foreground">{l.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConfigureDialog({ p, onClose }: { p: IntegrationProviderInfo; onClose: () => void }) {
  const { t } = useI18n();
  const { save } = useIntegrationActions();
  const { note, clear, toast } = useNoteToast();
  const [account, setAccount] = useState(p.connection?.externalAccountId ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Blank secret fields are not sent, so a saved secret is kept unless replaced.
    const credentials = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));
    save.mutate(
      { provider: p.key, externalAccountId: account || undefined, credentials },
      { onSuccess: onClose, onError: (err) => toast.error(err instanceof ApiError ? err.message : t("settings.integrations.saveFailed")) },
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.connection ? t("settings.integrations.configure") : t("settings.integrations.connect")} {p.name}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {rich(t("settings.integrations.dialog.intro", { name: p.name }), {
            b: (text) => <span className="font-medium text-foreground">{text}</span>,
          })}
        </p>
        <form onSubmit={submit} className="flex flex-col gap-3" autoComplete="off">
          {p.accountIdLabel && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="hub-account">{p.accountIdLabel}</Label>
              <Input id="hub-account" value={account} maxLength={120} onChange={(e) => setAccount(e.target.value)} />
            </div>
          )}
          {p.credentialFields.map((f) => {
            const isSet = p.connection?.credentialsSet[f.key];
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`hub-${f.key}`}>
                  {f.label}
                  {f.required ? "" : ` ${t("settings.integrations.optional")}`}
                </Label>
                {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
                {f.key === "webhookSecret" && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const b = new Uint8Array(24);
                        crypto.getRandomValues(b);
                        const v = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
                        setValues({ ...values, [f.key]: v });
                      }}
                    >
                      {t("settings.integrations.generateSecret")}
                    </Button>
                    {values[f.key] && <CopyButton text={values[f.key]} label={t("settings.integrations.copySecret")} />}
                  </div>
                )}
                <Input
                  id={`hub-${f.key}`}
                  type={f.secret && f.key !== "webhookSecret" ? "password" : "text"}
                  autoComplete="off"
                  maxLength={500}
                  placeholder={isSet ? t("settings.integrations.savedPlaceholder") : ""}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </div>
            );
          })}
          <StatusNote note={note} onClear={clear} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("settings.integrations.cancel")}</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? t("settings.integrations.saving") : t("settings.integrations.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkCard({ href, icon: Icon, title, text }: { href: string; icon: typeof Webhook; title: string; text: string }) {
  const { t } = useI18n();
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-2xl border border-border bg-card p-5 outline-none transition hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <h3 className="text-[18px] font-medium text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{text}</p>
        <span className="mt-2 inline-block text-sm font-medium text-primary group-hover:underline">{t("settings.integrations.open")}</span>
      </div>
    </Link>
  );
}

export default function IntegrationsPage() {
  const { t } = useI18n();
  const { data, isLoading, isError, error } = useIntegrationHub();
  const [configuring, setConfiguring] = useState<string | null>(null);
  const delivery = data?.filter((p) => p.category === "FOOD_DELIVERY") ?? [];
  const current = data?.find((p) => p.key === configuring);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.integrations.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.integrations.subtitle")}</p>
      </div>
      <SettingsTabs />

      <section aria-labelledby="int-delivery" className="flex flex-col gap-3">
        <h2 id="int-delivery" className="text-[20px] font-medium text-foreground">{t("settings.integrations.delivery.title")}</h2>
        {delivery.find((p) => p.webhookPath)?.requirements && (
          <p className="text-sm text-muted-foreground">{delivery.find((p) => p.webhookPath)?.requirements}</p>
        )}
        {isLoading ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : isError ? (
          <p role="alert" className="text-sm text-destructive">
            {error instanceof ApiError ? error.message : t("settings.integrations.loadFailed")}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {delivery.map((p) => (
              <ProviderCard key={p.key} p={p} onConfigure={() => setConfiguring(p.key)} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="int-dev" className="flex flex-col gap-3">
        <h2 id="int-dev" className="text-[20px] font-medium text-foreground">{t("settings.integrations.dev.title")}</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <LinkCard href="/settings/webhooks" icon={Webhook} title={t("settings.integrations.dev.webhooks.title")} text={t("settings.integrations.dev.webhooks.text")} />
          <LinkCard href="/settings/api-keys" icon={KeyRound} title={t("settings.integrations.dev.api.title")} text={t("settings.integrations.dev.api.text")} />
        </div>
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {t("settings.integrations.notBuilt")}
      </p>

      {current && <ConfigureDialog key={current.key} p={current} onClose={() => setConfiguring(null)} />}
    </div>
  );
}
