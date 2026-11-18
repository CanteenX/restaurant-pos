"use client";

import { useRef, useState } from "react";
import { toast } from "@/lib/toast";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useBranch } from "@/hooks/use-branch";
import { useSettings } from "@/hooks/use-settings";
import {
  useVerifactuActions,
  useVerifactuRecords,
  useVerifactuSettings,
  type VerifactuEnvironment,
  type VerifactuRecordRow,
  type VerifactuSettings,
} from "@/hooks/use-verifactu";
import { ApiError } from "@/lib/api";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const euro = (cents: number) => `${(cents / 100).toFixed(2)} €`;

const STATUS_KEY = {
  PENDING: "settings.verifactu.status.PENDING",
  ACCEPTED: "settings.verifactu.status.ACCEPTED",
  ACCEPTED_WITH_ERRORS: "settings.verifactu.status.ACCEPTED_WITH_ERRORS",
  REJECTED: "settings.verifactu.status.REJECTED",
  ERROR: "settings.verifactu.status.ERROR",
} as const satisfies Record<VerifactuRecordRow["status"], TranslationKey>;

function SettingsForm({ branchId, s }: { branchId: string; s: VerifactuSettings }) {
  const { t } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("settings.verifactu.error"));
  const { save, certificate } = useVerifactuActions(branchId);
  const [enabled, setEnabled] = useState(s.enabled);
  const [environment, setEnvironment] = useState<VerifactuEnvironment>(s.environment);
  const [series, setSeries] = useState(s.seriesPrefix);
  const [password, setPassword] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const hasRecords = Object.values(s.counts).some((n) => n > 0);

  return (
    <Card className="flex max-w-3xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t("settings.verifactu.form.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("settings.verifactu.form.desc")}
        </p>
      </div>

      <div role="note" className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
        <strong>{t("settings.verifactu.notice.title")}</strong> {t("settings.verifactu.notice.body")}
      </div>

      {s.problems.length > 0 && (
        <ul className="list-disc rounded-xl border border-destructive/30 bg-destructive/5 p-4 pl-8 text-sm text-destructive">
          {s.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="vf-enabled">{t("settings.verifactu.enable.label")}</Label>
          <p className="text-xs text-muted-foreground">{t("settings.verifactu.enable.help")}</p>
        </div>
        <Switch id="vf-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vf-env">{t("settings.verifactu.env.label")}</Label>
          <select
            id="vf-env"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as VerifactuEnvironment)}
          >
            <option value="TEST">{t("settings.verifactu.env.test")}</option>
            <option value="PRODUCTION">{t("settings.verifactu.env.production")}</option>
          </select>
          <p className="text-xs text-muted-foreground">{t("settings.verifactu.env.help")}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vf-series">{t("settings.verifactu.series.label")}</Label>
          <Input id="vf-series" value={series} maxLength={12} disabled={hasRecords} onChange={(e) => setSeries(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            {t("settings.verifactu.series.next", {
              number: `${s.seriesPrefix}-${String(s.nextNumber).padStart(6, "0")}`,
            })}
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              { enabled, environment, seriesPrefix: series },
              { onSuccess: () => toast.success(t("settings.verifactu.saved")), onError: (e) => toast.error(errMsg(e)) },
            )
          }
        >
          {t("settings.verifactu.save")}
        </Button>
      </div>

      <hr className="border-border" />

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="font-medium text-foreground">{t("settings.verifactu.cert.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings.verifactu.cert.desc")}
          </p>
        </div>
        {s.hasCertificate ? (
          <p className="text-sm">
            {t("settings.verifactu.cert.loaded")} <span className="font-mono text-xs">{s.certSubject}</span>
            {s.certExpiresAt && (
              <> · {t("settings.verifactu.cert.expires", { date: new Date(s.certExpiresAt).toLocaleDateString() })}</>
            )}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.verifactu.cert.none")}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vf-cert">{t("settings.verifactu.cert.file")}</Label>
            <input id="vf-cert" ref={file} type="file" accept=".p12,.pfx" className="text-sm" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="vf-pass">{t("settings.verifactu.cert.password")}</Label>
            <Input id="vf-pass" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button
            variant="outline"
            disabled={certificate.isPending}
            onClick={() => {
              const f = file.current?.files?.[0];
              if (!f) return toast.error(t("settings.verifactu.cert.chooseFile"));
              certificate.mutate(
                { file: f, password },
                {
                  onSuccess: () => {
                    setPassword("");
                    if (file.current) file.current.value = "";
                    toast.success(t("settings.verifactu.cert.saved"));
                  },
                  onError: (e) => toast.error(errMsg(e)),
                },
              );
            }}
          >
            {t("settings.verifactu.cert.upload")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Records({ branchId, s }: { branchId: string; s: VerifactuSettings }) {
  const { t, plural } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("settings.verifactu.error"));
  const { data, isLoading } = useVerifactuRecords(branchId);
  const { send, verify } = useVerifactuActions(branchId);
  const [result, setResult] = useState<string | null>(null);

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("settings.verifactu.records.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {Object.entries(s.counts)
              .map(([k, n]) => {
                const key = STATUS_KEY[k as VerifactuRecordRow["status"]];
                return `${n} ${key ? t(key).toLowerCase() : k}`;
              })
              .join(" · ") || t("settings.verifactu.records.none")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={verify.isPending}
            onClick={() =>
              verify.mutate(undefined, {
                onSuccess: (r) =>
                  setResult(
                    r.ok
                      ? plural("settings.verifactu.chain.ok", r.checked)
                      : t("settings.verifactu.chain.broken", {
                          at: r.brokenAt ?? "",
                          env: r.environment.toLowerCase(),
                          reason: r.reason ?? "",
                        }),
                  ),
                onError: (e) => toast.error(errMsg(e)),
              })
            }
          >
            {t("settings.verifactu.chain.check")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={send.isPending}
            onClick={() =>
              send.mutate(undefined, {
                onSuccess: (r) => toast.success(r.sent ? plural("settings.verifactu.sent", r.sent) : t("settings.verifactu.sent.nothing")),
                onError: (e) => toast.error(errMsg(e)),
              })
            }
          >
            {t("settings.verifactu.sendNow")}
          </Button>
          <Button variant="outline" size="sm" render={<a href={`/api/v1/verifactu/export.xml?branchId=${encodeURIComponent(branchId)}`} />}>
            {t("settings.verifactu.exportXml")}
          </Button>
        </div>
      </div>
      {result && (
        <p role="status" className="text-sm text-foreground">
          {result}
        </p>
      )}
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : !data || data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("settings.verifactu.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-4">{t("settings.verifactu.col.invoice")}</th>
                <th className="py-2 pr-4">{t("settings.verifactu.col.date")}</th>
                <th className="py-2 pr-4 text-right">{t("settings.verifactu.col.total")}</th>
                <th className="py-2 pr-4">{t("settings.verifactu.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.invoiceNumber} <span className="text-muted-foreground">{r.invoiceType}</span>
                  </td>
                  <td className="py-2 pr-4">{r.issueDate}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{euro(r.totalCents)}</td>
                  <td className={cn("py-2 pr-4", r.status === "REJECTED" && "text-destructive")}>
                    {t(STATUS_KEY[r.status])}
                    {r.errorText && <span className="block text-xs text-muted-foreground">{r.errorCode ? `${r.errorCode}: ` : ""}{r.errorText}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function VerifactuPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const { data, isLoading } = useVerifactuSettings(branchId);
  const country = useSettings(branchId).data?.branch.country;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.verifactu.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.verifactu.subtitle")}</p>
      </div>
      <SettingsTabs />
      {country && country !== "ES" ? (
        <Card className="max-w-3xl p-6 text-sm">
          {t("settings.verifactu.notSpain")}
        </Card>
      ) : isLoading || !data || !branchId ? (
        <Skeleton className="h-72 max-w-3xl rounded-xl" />
      ) : (
        <>
          <SettingsForm key={`${branchId}|${data.enabled}|${data.environment}|${data.seriesPrefix}`} branchId={branchId} s={data} />
          <Records branchId={branchId} s={data} />
        </>
      )}
    </div>
  );
}
