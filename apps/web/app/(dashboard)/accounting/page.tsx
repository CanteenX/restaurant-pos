"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAccountingActions,
  useBranchOverview,
  useClosingPreview,
  useClosings,
  useExpenses,
  useGst,
  useProfitLoss,
} from "@/hooks/use-accounting";
import { useBranch } from "@/hooks/use-branch";
import { ApiError } from "@/lib/api";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ApprovalThreshold, ExpenseStatusBadge, PendingExpenses } from "@/components/accounting/expense-approvals";
import { TallyTab } from "@/components/accounting/tally-tab";
import { BalanceSheetTab, BankTab, BudgetsTab } from "@/components/accounting/finance-tabs";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const TABS = ["expenses", "cashClose", "profitLoss", "balanceSheet", "budgets", "bank", "gst", "tally", "branches"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, TranslationKey> = {
  expenses: "acct.tab.expenses",
  cashClose: "acct.tab.cashClose",
  profitLoss: "acct.tab.profitLoss",
  balanceSheet: "acct.tab.balanceSheet",
  budgets: "acct.tab.budgets",
  bank: "acct.tab.bank",
  gst: "acct.tab.gst",
  tally: "acct.tab.tally",
  branches: "acct.tab.branches",
};

function monthRange() {
  const now = new Date();
  return {
    from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    to: iso(now),
  };
}

function RangePicker({
  range,
  onChange,
}: {
  range: { from: string; to: string };
  onChange: (r: { from: string; to: string }) => void;
}) {
  return (
    <div className="flex gap-2">
      <Input type="date" className="w-40" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} />
      <Input type="date" className="w-40" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} />
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between py-1.5 text-sm", strong && "border-t border-border font-semibold")}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Expenses({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("acct.error"));
  const [range, setRange] = useState(monthRange);
  const { data, isLoading } = useExpenses(branchId, range.from, range.to);
  const { addExpense, deleteExpense } = useAccountingActions(branchId);
  const [f, setF] = useState({ spentOn: iso(new Date()), category: "", amount: "", note: "", paidFromCash: false });
  const total = data?.reduce((s, e) => s + Number(e.amount), 0) ?? 0;

  const submit = () => {
    const amount = Number(f.amount);
    if (!f.category.trim() || !(amount > 0)) return toast.error(t("acct.exp.needCategoryAmount"));
    addExpense.mutate(
      { spentOn: f.spentOn, category: f.category.trim(), amount, note: f.note || undefined, paidFromCash: f.paidFromCash },
      {
        onSuccess: () => {
          toast.success(t("acct.exp.added"));
          setF({ ...f, category: "", amount: "", note: "" });
        },
        onError: (e) => toast.error(errMsg(e)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Input type="date" value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} />
        <Input placeholder={t("acct.exp.category")} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        <Input placeholder={t("acct.exp.amount")} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        <Input placeholder={t("acct.exp.note")} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.paidFromCash} onChange={(e) => setF({ ...f, paidFromCash: e.target.checked })} />
          {t("acct.exp.paidFromTill")}
        </label>
        <div className="sm:col-span-2 lg:col-span-5">
          <Button onClick={submit} disabled={addExpense.isPending}>{t("acct.exp.add")}</Button>
        </div>
      </Card>
      <PendingExpenses branchId={branchId} />
      <ApprovalThreshold branchId={branchId} />
      <RangePicker range={range} onChange={setRange} />
      <Card className="flex flex-col divide-y divide-border p-2">
        {isLoading ? (
          <Skeleton className="m-4 h-12" />
        ) : data && data.length > 0 ? (
          <>
            {data.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-medium text-foreground">{e.category}</span>
                  <span className="text-muted-foreground"> · {e.spentOn.slice(0, 10)}{e.note && ` · ${e.note}`}{e.paidFromCash && ` · ${t("acct.exp.till")}`}</span>
                </span>
                <span className="flex items-center gap-3">
                  {formatCurrency(e.amount)}
                  <ExpenseStatusBadge status={e.status} />
                  <Button size="sm" variant="outline" onClick={() => deleteExpense.mutate(e.id, { onError: (err) => toast.error(errMsg(err)) })}>
                    {t("acct.exp.delete")}
                  </Button>
                </span>
              </div>
            ))}
            <div className="flex justify-between px-4 py-2.5 text-sm font-semibold">
              <span>{t("acct.total")}</span>
              <span>{formatCurrency(total)}</span>
            </div>
          </>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("acct.exp.empty")}</p>
        )}
      </Card>
    </div>
  );
}

function CashClose({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : t("acct.error"));
  const [date, setDate] = useState(() => iso(new Date()));
  const [floor, setFloor] = useState("0");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const { data: preview } = useClosingPreview(branchId, date, Number(floor) || 0);
  const { data: closings } = useClosings(branchId);
  const { closeDay } = useAccountingActions(branchId);
  const variance = preview && counted !== "" ? Number(counted) - preview.expectedCash : null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap gap-3">
          <Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input className="w-40" inputMode="decimal" placeholder={t("acct.close.openingFloat")} value={floor} onChange={(e) => setFloor(e.target.value)} />
        </div>
        {preview && (
          <div>
            <Row label={t("acct.close.openingFloat")} value={formatCurrency(preview.openingFloat)} />
            <Row label={t("acct.close.cashSales")} value={formatCurrency(preview.cashSales)} />
            <Row label={t("acct.close.cashExpenses")} value={`− ${formatCurrency(preview.cashExpenses)}`} />
            <Row strong label={t("acct.close.expected")} value={formatCurrency(preview.expectedCash)} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-40" inputMode="decimal" placeholder={t("acct.close.counted")} value={counted} onChange={(e) => setCounted(e.target.value)} />
          {variance != null && (
            <span className={cn("text-sm", variance === 0 ? "text-success" : "text-destructive")}>
              {variance === 0
                ? t("acct.close.balanced")
                : t(variance > 0 ? "acct.close.over" : "acct.close.short", { amount: formatCurrency(Math.abs(variance)) })}
            </span>
          )}
        </div>
        <Input placeholder={t("acct.close.noteOptional")} value={note} onChange={(e) => setNote(e.target.value)} />
        <div>
          <Button
            disabled={counted === "" || closeDay.isPending}
            onClick={() =>
              closeDay.mutate(
                { businessDate: date, openingFloat: Number(floor) || 0, countedCash: Number(counted), note: note || undefined },
                { onSuccess: () => { toast.success(t("acct.close.closed")); setCounted(""); setNote(""); }, onError: (e) => toast.error(errMsg(e)) },
              )
            }
          >
            {t("acct.close.closeDay")}
          </Button>
        </div>
      </Card>
      <Card className="flex flex-col divide-y divide-border p-2">
        {closings && closings.length > 0 ? (
          closings.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span>{c.businessDate.slice(0, 10)}</span>
              <span className="text-muted-foreground">
                {t("acct.close.row", { expected: formatCurrency(c.expectedCash), counted: formatCurrency(c.countedCash), variance: formatCurrency(c.variance) })}
              </span>
            </div>
          ))
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("acct.close.none")}</p>
        )}
      </Card>
    </div>
  );
}

function ProfitLossTab({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [range, setRange] = useState(monthRange);
  const { data } = useProfitLoss(branchId, range.from, range.to);
  return (
    <div className="flex flex-col gap-4">
      <RangePicker range={range} onChange={setRange} />
      <Card className="p-4">
        {data ? (
          <div>
            <Row label={t("acct.pl.collected", { count: data.orders })} value={formatCurrency(data.grossCollected)} />
            <Row label={t("acct.pl.tax")} value={`− ${formatCurrency(data.taxCollected)}`} />
            <Row label={t("acct.pl.refunds")} value={`− ${formatCurrency(data.refunds)}`} />
            <Row strong label={t("acct.pl.netSales")} value={formatCurrency(data.netSales)} />
            {data.expenses.map((e) => (
              <Row key={e.category} label={e.category} value={`− ${formatCurrency(e.amount)}`} />
            ))}
            <Row label={t("acct.pl.payroll")} value={`− ${formatCurrency(data.payrollCost)}`} />
            <Row strong label={t("acct.pl.netProfit")} value={formatCurrency(data.netProfit)} />
          </div>
        ) : (
          <Skeleton className="h-32" />
        )}
      </Card>
    </div>
  );
}

function GstTab({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [range, setRange] = useState(monthRange);
  const { data } = useGst(branchId, range.from, range.to);
  return (
    <div className="flex flex-col gap-4">
      <RangePicker range={range} onChange={setRange} />
      <Card className="overflow-x-auto p-4">
        {data ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">{t("acct.gst.rate")}</th><th>{t("acct.gst.taxable")}</th><th>{t("acct.gst.tax")}</th><th className="text-right">{t("acct.total")}</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.ratePercent} className="border-t border-border">
                  <td className="py-1.5">{r.ratePercent}%</td>
                  <td>{formatCurrency(r.taxableValue)}</td>
                  <td>{formatCurrency(r.tax)}</td>
                  <td className="text-right">{formatCurrency(r.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-border font-semibold">
                <td className="py-1.5">{t("acct.total")}</td>
                <td>{formatCurrency(data.totalTaxable)}</td>
                <td>{formatCurrency(data.totalTax)}</td>
                <td className="text-right">{formatCurrency(data.totalTaxable + data.totalTax)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <Skeleton className="h-24" />
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {t("acct.gst.note")}
        </p>
      </Card>
    </div>
  );
}

function BranchesTab() {
  const { t } = useI18n();
  const [range, setRange] = useState(monthRange);
  const { data } = useBranchOverview(range.from, range.to);
  return (
    <div className="flex flex-col gap-4">
      <RangePicker range={range} onChange={setRange} />
      <Card className="overflow-x-auto p-4">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-1">{t("acct.br.branch")}</th><th>{t("acct.br.orders")}</th><th>{t("acct.br.sales")}</th><th>{t("acct.br.open")}</th><th>{t("acct.br.lowStock")}</th><th className="text-right">{t("acct.br.inventoryValue")}</th></tr>
          </thead>
          <tbody>
            {data?.map((b) => (
              <tr key={b.branchId} className="border-t border-border">
                <td className="py-1.5">{b.name}</td>
                <td>{b.orders}</td>
                <td>{formatCurrency(b.sales)}</td>
                <td>{b.openOrders}</td>
                <td>{b.lowStockItems}</td>
                <td className="text-right">{formatCurrency(b.inventoryValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export default function AccountingPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const [tab, setTab] = useState<Tab>("expenses");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("acct.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("acct.subtitle")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full border px-3.5 py-1 text-xs transition-colors",
              tab === id ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary",
            )}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>
      {tab === "expenses" && <Expenses branchId={branchId} />}
      {tab === "cashClose" && <CashClose branchId={branchId} />}
      {tab === "profitLoss" && <ProfitLossTab branchId={branchId} />}
      {tab === "balanceSheet" && <BalanceSheetTab branchId={branchId} />}
      {tab === "budgets" && <BudgetsTab branchId={branchId} />}
      {tab === "bank" && <BankTab branchId={branchId} />}
      {tab === "gst" && <GstTab branchId={branchId} />}
      {tab === "tally" && <TallyTab branchId={branchId} />}
      {tab === "branches" && <BranchesTab />}
    </div>
  );
}
