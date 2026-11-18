"use client";

import { useSearchParams } from "next/navigation";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { AdjustLineDialog, PayRunDialog, SlipButton } from "@/components/team/payroll-dialogs";
import { Suspense, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/hooks/use-branch";
import {
  useHrActions,
  useLeave,
  usePay,
  usePayrollRun,
  usePayrollRuns,
  usePerformance,
  useShifts,
} from "@/hooks/use-hr";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const fmtDate = (s: string) => new Date(s).toLocaleDateString([], { day: "numeric", month: "short" });
const fmtTime = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const TABS = ["schedule", "leave", "payroll", "performance"] as const;
type Tab = (typeof TABS)[number];

function Schedule({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [from, setFrom] = useState(() => iso(new Date()));
  const to = iso(addDays(new Date(from), 6));
  const { data: shifts, isLoading } = useShifts(branchId, from, to);
  const { data: staff } = usePay(branchId);
  const { addShift, deleteShift } = useHrActions(branchId);
  const [form, setForm] = useState({ userId: "", date: iso(new Date()), start: "09:00", end: "17:00" });

  const submit = () => {
    if (!form.userId) return toast.error(t("team.schedule.pickStaff"));
    addShift.mutate(
      {
        userId: form.userId,
        startsAt: new Date(`${form.date}T${form.start}`).toISOString(),
        endsAt: new Date(`${form.date}T${form.end}`).toISOString(),
      },
      { onSuccess: () => toast.success(t("team.schedule.shiftAdded")), onError: (e) => toast.error(errMsg(e, t("team.error.generic"))) },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="grid gap-3 p-4 sm:grid-cols-5">
        <select
          aria-label={t("team.schedule.staffLabel")}
          value={form.userId}
          onChange={(e) => setForm({ ...form, userId: e.target.value })}
          className="rounded-lg border border-border bg-background px-2 py-2 text-sm"
        >
          <option value="">{t("team.schedule.staffPlaceholder")}</option>
          {staff?.map((s) => (
            <option key={s.userId} value={s.userId}>
              {s.name}
            </option>
          ))}
        </select>
        <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
        <Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
        <Button onClick={submit} disabled={addShift.isPending}>{t("team.schedule.addShift")}</Button>
      </Card>
      <div className="flex items-center gap-2 text-sm">
        <Button size="sm" variant="outline" onClick={() => setFrom(iso(addDays(new Date(from), -7)))}>{t("team.schedule.prev")}</Button>
        <span className="text-muted-foreground">{fmtDate(from)} – {fmtDate(to)}</span>
        <Button size="sm" variant="outline" onClick={() => setFrom(iso(addDays(new Date(from), 7)))}>{t("team.schedule.next")}</Button>
      </div>
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : shifts && shifts.length > 0 ? (
          shifts.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="font-medium text-foreground">{s.user.name}</span>
              <span className="text-muted-foreground">
                {fmtDate(s.startsAt)} · {fmtTime(s.startsAt)} – {fmtTime(s.endsAt)}
              </span>
              <Button size="sm" variant="outline" onClick={() => deleteShift.mutate(s.id)}>{t("team.schedule.remove")}</Button>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("team.schedule.empty")}</p>
        )}
      </Card>
    </div>
  );
}

function Leave({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = useLeave(branchId);
  const { decideLeave } = useHrActions(branchId);
  return (
    <Card className="flex flex-col divide-y divide-border p-2">
      {isLoading ? (
        <Skeleton className="m-4 h-12" />
      ) : data && data.length > 0 ? (
        data.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <p className="font-medium text-foreground">
                {l.user?.name} · {l.type.toLowerCase()}
              </p>
              <p className="text-xs text-muted-foreground">
                {fmtDate(l.startDate)} – {fmtDate(l.endDate)}
                {l.reason && ` · ${l.reason}`}
              </p>
            </div>
            {l.status === "PENDING" ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => decideLeave.mutate({ id: l.id, status: "APPROVED" }, { onError: (e) => toast.error(errMsg(e, t("team.error.generic"))) })}>
                  {t("team.leave.approve")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => decideLeave.mutate({ id: l.id, status: "REJECTED" }, { onError: (e) => toast.error(errMsg(e, t("team.error.generic"))) })}>
                  {t("team.leave.reject")}
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{l.status.toLowerCase()}</span>
            )}
          </div>
        ))
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("team.leave.empty")}</p>
      )}
    </Card>
  );
}

function RunDetail({ branchId, id }: { branchId: string | null; id: string }) {
  const { t, formatCurrency } = useI18n();
  const generic = t("team.error.generic");
  const { data } = usePayrollRun(branchId, id);
  const { finalizeRun, deleteRun } = useHrActions(branchId);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const { note, clear, toast: runToast } = useNoteToast();
  if (!data) return <Skeleton className="h-24" />;
  const editable = data.status === "DRAFT";
  const adjustingLine = data.lines.find((l) => l.user.id === adjusting);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {t("team.run.summary", {
            period: `${fmtDate(data.periodStart)} – ${fmtDate(data.periodEnd)}`,
            status: data.status.toLowerCase(),
            tipPool: formatCurrency(data.tipPool),
          })}
          {data.status === "PAID" && data.paidAt
            ? data.paymentMethod
              ? t("team.run.paidOnBy", { date: fmtDate(data.paidAt), method: data.paymentMethod.replace("_", " ").toLowerCase() })
              : t("team.run.paidOn", { date: fmtDate(data.paidAt) })
            : ""}
        </p>
        {data.status === "DRAFT" && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => finalizeRun.mutate(id, { onSuccess: () => runToast.success(t("team.run.finalized")), onError: (e) => runToast.error(errMsg(e, generic)) })}>
              {t("team.run.finalize")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => deleteRun.mutate(id, { onError: (e) => runToast.error(errMsg(e, generic)) })}>{t("team.run.discard")}</Button>
          </div>
        )}
        {data.status === "FINALIZED" && (
          <Button size="sm" onClick={() => setPaying(true)}>{t("team.run.markPaid")}</Button>
        )}
      </div>
      <StatusNote note={note} onClear={clear} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1">{t("team.run.col.staff")}</th><th>{t("team.run.col.hours")}</th><th>{t("team.run.col.base")}</th><th>{t("team.run.col.leave")}</th><th>{t("team.run.col.tips")}</th>
              <th>{t("team.run.col.allowances")}</th><th>{t("team.run.col.bonus")}</th><th>{t("team.run.col.advance")}</th><th>{t("team.run.col.other")}</th>
              <th className="text-right">{t("team.run.col.net")}</th><th />
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="py-1.5">{l.user.name}</td>
                <td>{l.hoursWorked}</td>
                <td>{formatCurrency(l.basePay)}</td>
                <td>{formatCurrency(l.unpaidLeaveDeduction)}</td>
                <td>{formatCurrency(l.tipShare)}</td>
                <td>{formatCurrency(l.allowances)}</td>
                <td>{formatCurrency(l.bonus)}</td>
                <td>{formatCurrency(l.advanceRecovery)}</td>
                <td>{formatCurrency(l.otherDeductions)}</td>
                <td className="text-right font-medium">{formatCurrency(l.netPay)}</td>
                <td className="whitespace-nowrap text-right">
                  {editable && (
                    <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setAdjusting(l.user.id)}>
                      {t("team.run.adjust")}
                    </Button>
                  )}
                  <SlipButton branchId={branchId} runId={id} userId={l.user.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-right text-sm font-semibold">{t("team.run.total", { amount: formatCurrency(data.totalNet) })}</p>
      {adjustingLine && (
        <AdjustLineDialog key={adjustingLine.id} branchId={branchId} runId={id} line={adjustingLine} onClose={() => setAdjusting(null)} />
      )}
      {paying && <PayRunDialog branchId={branchId} runId={id} total={data.totalNet} onClose={() => setPaying(false)} />}
    </Card>
  );
}

function Payroll({ branchId }: { branchId: string | null }) {
  const { t, formatCurrency } = useI18n();
  const { data: pay } = usePay(branchId);
  const { data: runs } = usePayrollRuns(branchId);
  const { setPay, createRun } = useHrActions(branchId);
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { start: iso(first), end: iso(last) };
  });
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { payType: "MONTHLY" | "HOURLY"; rate: string }>>({});

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <p className="text-sm font-medium text-foreground">{t("team.pay.rates")}</p>
        {pay?.map((p) => {
          const d = draft[p.userId] ?? { payType: p.payType ?? "MONTHLY", rate: String(p.rate ?? "") };
          return (
            <div key={p.userId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-40 truncate">{p.name}</span>
              <select
                aria-label={t("team.pay.payType")}
                value={d.payType}
                onChange={(e) => setDraft({ ...draft, [p.userId]: { ...d, payType: e.target.value as "MONTHLY" | "HOURLY" } })}
                className="rounded-lg border border-border bg-background px-2 py-1.5"
              >
                <option value="MONTHLY">{t("team.pay.monthly")}</option>
                <option value="HOURLY">{t("team.pay.hourly")}</option>
              </select>
              <Input
                className="w-28"
                inputMode="decimal"
                placeholder={t("team.pay.ratePlaceholder")}
                value={d.rate}
                onChange={(e) => setDraft({ ...draft, [p.userId]: { ...d, rate: e.target.value } })}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setPay.mutate(
                    { userId: p.userId, payType: d.payType, rate: Number(d.rate) },
                    { onSuccess: () => toast.success(t("team.pay.saved")), onError: (e) => toast.error(errMsg(e, t("team.error.generic"))) },
                  )
                }
              >
                {t("team.pay.save")}
              </Button>
            </div>
          );
        })}
      </Card>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Input type="date" className="w-40" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} />
        <Input type="date" className="w-40" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} />
        <Button
          disabled={createRun.isPending}
          onClick={() =>
            createRun.mutate(
              { periodStart: period.start, periodEnd: period.end },
              {
                onSuccess: (r) => setOpen((r as { id: string }).id),
                onError: (e) => toast.error(errMsg(e, t("team.error.generic"))),
              },
            )
          }
        >
          {t("team.pay.runPayroll")}
        </Button>
        <p className="w-full text-xs text-muted-foreground">
          {t("team.pay.runHint")}
        </p>
      </Card>
      {runs?.map((r) => (
        <div key={r.id} className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setOpen(open === r.id ? null : r.id)}
            className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm hover:bg-secondary"
          >
            <span>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)} · {r.status.toLowerCase()}</span>
            <span className="font-medium">{formatCurrency(r.totalNet)}</span>
          </button>
          {open === r.id && <RunDetail branchId={branchId} id={r.id} />}
        </div>
      ))}
    </div>
  );
}

function Performance({ branchId }: { branchId: string | null }) {
  const { t, formatCurrency } = useI18n();
  const [range, setRange] = useState(() => ({ from: iso(addDays(new Date(), -29)), to: iso(new Date()) }));
  const { data, isLoading } = usePerformance(branchId, range.from, range.to);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Input type="date" className="w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <Input type="date" className="w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
      </div>
      <Card className="overflow-x-auto p-4">
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">{t("team.run.col.staff")}</th><th>{t("team.perf.orders")}</th><th>{t("team.perf.sales")}</th><th>{t("team.run.col.tips")}</th><th>{t("team.run.col.hours")}</th><th className="text-right">{t("team.perf.salesPerHour")}</th></tr>
            </thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.userId} className="border-t border-border">
                  <td className="py-1.5">{r.name}</td>
                  <td>{r.orders}</td>
                  <td>{formatCurrency(r.sales)}</td>
                  <td>{formatCurrency(r.tips)}</td>
                  <td>{r.hoursWorked}</td>
                  <td className="text-right">{r.salesPerHour == null ? "—" : formatCurrency(r.salesPerHour)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function TeamView() {
  const { t: tr } = useI18n();
  const { branchId } = useBranch();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get("tab");
    return TABS.find((x) => x === t) ?? "schedule";
  });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{tr("team.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("team.subtitle")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded-full border px-3.5 py-1 text-xs capitalize transition-colors",
              tab === t ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary",
            )}
          >
            {tr(`team.tab.${t}`)}
          </button>
        ))}
      </div>
      {tab === "schedule" && <Schedule branchId={branchId} />}
      {tab === "leave" && <Leave branchId={branchId} />}
      {tab === "payroll" && <Payroll branchId={branchId} />}
      {tab === "performance" && <Performance branchId={branchId} />}
    </div>
  );
}

export default function TeamPage() {
  return (
    <Suspense fallback={null}>
      <TeamView />
    </Suspense>
  );
}
