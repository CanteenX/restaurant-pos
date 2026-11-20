"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/hooks/use-branch";
import {
  useAudience,
  useCampaigns,
  useCoupons,
  useMarketingActions,
  usePromotions,
} from "@/hooks/use-marketing";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

type Translate = ReturnType<typeof useI18n>["t"];

const errMsg = (e: unknown, t: Translate) => (e instanceof ApiError ? e.message : t("marketing.error"));
const DAY_KEYS = [
  "marketing.day.0",
  "marketing.day.1",
  "marketing.day.2",
  "marketing.day.3",
  "marketing.day.4",
  "marketing.day.5",
  "marketing.day.6",
] as const satisfies readonly TranslationKey[];
const TABS = [
  { key: "coupons", labelKey: "marketing.tab.coupons" },
  { key: "happy hour", labelKey: "marketing.tab.happyHour" },
  { key: "campaigns", labelKey: "marketing.tab.campaigns" },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[];
type Tab = (typeof TABS)[number]["key"];
const discountText = (kind: string, value: string, t: Translate) =>
  kind === "PERCENT"
    ? t("marketing.offPercent", { value: Number(value) })
    : t("marketing.offAmount", { amount: formatCurrency(value) });

function Coupons({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = useCoupons(branchId);
  const { createCoupon, couponActive, deleteCoupon } = useMarketingActions(branchId);
  const [f, setF] = useState({ code: "", kind: "PERCENT", value: "", minOrderAmount: "", usageLimit: "" });

  const submit = () => {
    createCoupon.mutate(
      {
        code: f.code,
        kind: f.kind,
        value: Number(f.value),
        minOrderAmount: f.minOrderAmount ? Number(f.minOrderAmount) : 0,
        usageLimit: f.usageLimit ? Number(f.usageLimit) : undefined,
      },
      {
        onSuccess: () => {
          toast.success(t("marketing.coupon.created"));
          setF({ ...f, code: "", value: "", minOrderAmount: "", usageLimit: "" });
        },
        onError: (e) => toast.error(errMsg(e, t)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <Input placeholder={t("marketing.coupon.code")} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <select aria-label={t("marketing.type")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="rounded-lg border border-border bg-background px-2 py-2 text-sm">
          <option value="PERCENT">{t("marketing.kind.percent")}</option>
          <option value="FLAT">{t("marketing.kind.flat")}</option>
        </select>
        <Input placeholder={t("marketing.value")} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        <Input placeholder={t("marketing.coupon.minOrder")} inputMode="decimal" value={f.minOrderAmount} onChange={(e) => setF({ ...f, minOrderAmount: e.target.value })} />
        <Input placeholder={t("marketing.coupon.maxUses")} inputMode="numeric" value={f.usageLimit} onChange={(e) => setF({ ...f, usageLimit: e.target.value })} />
        <Button onClick={submit} disabled={createCoupon.isPending}>{t("marketing.create")}</Button>
      </Card>
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : data && data.length > 0 ? (
          data.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className={cn("font-mono font-medium", !c.isActive && "text-muted-foreground line-through")}>{c.code}</p>
                <p className="text-xs text-muted-foreground">
                  {discountText(c.kind, c.value, t)}
                  {Number(c.minOrderAmount) > 0 && t("marketing.coupon.minOrderInfo", { amount: formatCurrency(c.minOrderAmount) })}
                  {c.usageLimit
                    ? t("marketing.coupon.usedOfInfo", { used: c.usedCount, limit: c.usageLimit })
                    : t("marketing.coupon.usedInfo", { used: c.usedCount })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => couponActive.mutate({ id: c.id, isActive: !c.isActive })}>
                  {c.isActive ? t("marketing.disable") : t("marketing.enable")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => confirm(t("marketing.coupon.deleteConfirm", { code: c.code })) && deleteCoupon.mutate(c.id)}>
                  {t("marketing.delete")}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("marketing.coupon.empty")}</p>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        {t("marketing.coupon.note")}
      </p>
    </div>
  );
}

function HappyHour({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = usePromotions(branchId);
  const { createPromotion, promotionActive, deletePromotion } = useMarketingActions(branchId);
  const [f, setF] = useState({ name: "", kind: "PERCENT", value: "", start: "16:00", end: "19:00", days: [1, 2, 3, 4, 5] as number[] });
  const toggleDay = (d: number) => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });

  const submit = () =>
    createPromotion.mutate(
      { name: f.name, kind: f.kind, value: Number(f.value), daysOfWeek: f.days, startTime: f.start, endTime: f.end },
      {
        onSuccess: () => { toast.success(t("marketing.hh.created")); setF({ ...f, name: "", value: "" }); },
        onError: (e) => toast.error(errMsg(e, t)),
      },
    );

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input placeholder={t("marketing.hh.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select aria-label={t("marketing.type")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="rounded-lg border border-border bg-background px-2 py-2 text-sm">
            <option value="PERCENT">{t("marketing.kind.percent")}</option>
            <option value="FLAT">{t("marketing.kind.flat")}</option>
          </select>
          <Input placeholder={t("marketing.value")} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          <Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          <Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {DAY_KEYS.map((n, d) => (
            <button key={n} type="button" onClick={() => toggleDay(d)} className={cn("rounded-full border px-3 py-1 text-xs", f.days.includes(d) ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>
              {t(n)}
            </button>
          ))}
          <Button className="ml-auto" onClick={submit} disabled={createPromotion.isPending}>{t("marketing.create")}</Button>
        </div>
      </Card>
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : data && data.length > 0 ? (
          data.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className={cn("font-medium", !p.isActive && "text-muted-foreground line-through")}>{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {discountText(p.kind, p.value, t)} · {p.daysOfWeek.map((d) => t(DAY_KEYS[d])).join(", ")} · {p.startTime}–{p.endTime}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => promotionActive.mutate({ id: p.id, isActive: !p.isActive })}>
                  {p.isActive ? t("marketing.pause") : t("marketing.resume")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => confirm(t("marketing.hh.deleteConfirm", { name: p.name })) && deletePromotion.mutate(p.id)}>
                  {t("marketing.delete")}
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("marketing.hh.empty")}</p>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">{t("marketing.hh.note")}</p>
    </div>
  );
}

function AudienceCount({ branchId, id }: { branchId: string | null; id: string }) {
  const { t } = useI18n();
  const { data } = useAudience(branchId, id);
  return <span>{data ? t("marketing.recipients", { count: data.count }) : "…"}</span>;
}

function Campaigns({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = useCampaigns(branchId);
  const { createCampaign, deleteCampaign, sendCampaign } = useMarketingActions(branchId);
  const [f, setF] = useState({ name: "", channel: "SMS", segment: "ALL", message: "" });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input placeholder={t("marketing.camp.namePlaceholder")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select aria-label={t("marketing.camp.channel")} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} className="rounded-lg border border-border bg-background px-2 py-2 text-sm">
            <option value="SMS">{"SMS"}</option>
            <option value="WHATSAPP">{"WhatsApp"}</option>
            <option value="EMAIL">{t("marketing.camp.channel.email")}</option>
          </select>
          <select aria-label={t("marketing.camp.audience")} value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} className="rounded-lg border border-border bg-background px-2 py-2 text-sm">
            <option value="ALL">{t("marketing.camp.segment.all")}</option>
            <option value="LOYAL">{t("marketing.camp.segment.loyal")}</option>
            <option value="LAPSED">{t("marketing.camp.segment.lapsed")}</option>
            <option value="BIRTHDAY_MONTH">{t("marketing.camp.segment.birthday")}</option>
          </select>
        </div>
        <textarea
          aria-label={t("marketing.camp.message")}
          placeholder={t("marketing.camp.message")}
          maxLength={600}
          value={f.message}
          onChange={(e) => setF({ ...f, message: e.target.value })}
          className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <div>
          <Button
            disabled={createCampaign.isPending}
            onClick={() =>
              createCampaign.mutate(f, {
                onSuccess: () => { toast.success(t("marketing.camp.saved")); setF({ ...f, name: "", message: "" }); },
                onError: (e) => toast.error(errMsg(e, t)),
              })
            }
          >
            {t("marketing.camp.save")}
          </Button>
        </div>
      </Card>
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : data && data.length > 0 ? (
          data.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <p className="font-medium text-foreground">{c.name} <span className="text-xs text-muted-foreground">· {c.channel.toLowerCase()} · {c.segment.toLowerCase().replace("_", " ")}</span></p>
                <p className="text-xs text-muted-foreground">{c.message}</p>
                <p className="text-xs text-muted-foreground">
                  <AudienceCount branchId={branchId} id={c.id} />
                  {c.lastSentAt && t("marketing.camp.lastSent", { when: new Date(c.lastSentAt).toLocaleString(), count: c.lastSentCount ?? 0 })}
                </p>
              </div>
              <div className="flex gap-2">
                <a href={`/api/v1/marketing/campaigns/${c.id}/audience.csv?branchId=${branchId}`} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-secondary">
                  <Download className="mr-2 h-4 w-4" /> {t("marketing.camp.audienceCsv")}
                </a>
                <Button
                  size="sm"
                  disabled={sendCampaign.isPending}
                  onClick={() =>
                    confirm(t("marketing.camp.sendConfirm", { name: c.name })) &&
                    sendCampaign.mutate(c.id, {
                      onSuccess: (r) => toast.success(r.failed ? t("marketing.camp.sentFailed", { sent: r.sent, failed: r.failed }) : t("marketing.camp.sent", { sent: r.sent })),
                      onError: (e) => toast.error(errMsg(e, t)),
                    })
                  }
                >
                  {t("marketing.camp.sendNow")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => confirm(t("marketing.camp.deleteConfirm", { name: c.name })) && deleteCampaign.mutate(c.id)}>{t("marketing.delete")}</Button>
              </div>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("marketing.camp.empty")}</p>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        {t("marketing.camp.note")}
      </p>
    </div>
  );
}

export default function MarketingPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const [tab, setTab] = useState<Tab>("coupons");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("marketing.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("marketing.subtitle")}</p>
      </div>
      <div className="flex gap-2">
        {TABS.map((tb) => (
          <button key={tb.key} type="button" onClick={() => setTab(tb.key)} className={cn("rounded-full border px-3.5 py-1 text-xs capitalize transition-colors", tab === tb.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary")}>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      {tab === "coupons" && <Coupons branchId={branchId} />}
      {tab === "happy hour" && <HappyHour branchId={branchId} />}
      {tab === "campaigns" && <Campaigns branchId={branchId} />}
    </div>
  );
}
