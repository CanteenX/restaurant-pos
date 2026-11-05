"use client";

import { useState } from "react";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useExpenseDecision, usePendingExpenses } from "@/hooks/use-accounting";
import { hasPermission, useCurrentUser } from "@/hooks/use-auth";
import { useSettings, useUpdateRestaurantSettings } from "@/hooks/use-settings";
import { ApiError } from "@/lib/api";
import { expenseStatusInfo, normalizeThreshold, pendingTotal, type ExpenseStatus } from "@/lib/expense-status";
import { formatCurrency } from "@/lib/format";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  warning: "bg-amber-100 text-amber-800",
  success: "bg-emerald-100 text-emerald-800",
  danger: "bg-red-100 text-red-800",
};

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus | undefined }) {
  const { t } = useI18n();
  const info = expenseStatusInfo(status);
  return (
    <span
      data-testid="expense-status"
      className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TONE[info.tone])}
    >
      {t(info.labelKey as TranslationKey)}
    </span>
  );
}

/** Approver queue; renders nothing for users without expenses.approve. */
export function PendingExpenses({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: me } = useCurrentUser();
  const canApprove = hasPermission(me?.user, "expenses.approve");
  const { data } = usePendingExpenses(branchId, canApprove);
  const decide = useExpenseDecision(branchId);
  const { note, clear, toast } = useNoteToast();
  if (!canApprove) return null;

  const act = (id: string, decision: "approve" | "reject") =>
    decide.mutate(
      { id, decision },
      {
        onSuccess: () => toast.success(t(decision === "approve" ? "acct.exp.approvals.approved" : "acct.exp.approvals.rejected")),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : t("acct.error")),
      },
    );

  return (
    <Card className="flex flex-col divide-y divide-border p-2" data-testid="pending-expenses">
      {note && <StatusNote note={note} onClear={clear} className="m-2" />}
      <div className="flex justify-between px-4 py-2.5 text-sm font-semibold">
        <span>{t("acct.exp.approvals.title")}</span>
        {data && data.length > 0 && (
          <span>{t("acct.exp.approvals.pendingTotal")}: {formatCurrency(pendingTotal(data))}</span>
        )}
      </div>
      {data && data.length > 0 ? (
        data.map((e) => (
          <div key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span>
              <span className="font-medium text-foreground">{e.category}</span>
              <span className="text-muted-foreground">
                {" · "}{e.spentOn.slice(0, 10)}
                {e.createdBy && ` · ${t("acct.exp.approvals.by", { name: e.createdBy.name })}`}
                {e.note && ` · ${e.note}`}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {formatCurrency(e.amount)}
              <Button size="sm" disabled={decide.isPending} onClick={() => act(e.id, "approve")}>
                {t("acct.exp.approvals.approve")}
              </Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => act(e.id, "reject")}>
                {t("acct.exp.approvals.reject")}
              </Button>
            </span>
          </div>
        ))
      ) : (
        <p className="p-6 text-center text-sm text-muted-foreground">{t("acct.exp.approvals.empty")}</p>
      )}
    </Card>
  );
}

/** Threshold setting; renders nothing without settings.manage. */
export function ApprovalThreshold({ branchId }: { branchId: string | null }) {
  const { data: me } = useCurrentUser();
  const canManage = hasPermission(me?.user, "settings.manage");
  const { data } = useSettings(canManage ? branchId : null);
  if (!canManage || !data) return null;
  const current = (data.restaurant as { expenseApprovalThreshold?: string | null }).expenseApprovalThreshold;
  return <ThresholdForm branchId={branchId} initial={current == null ? "" : String(Number(current))} />;
}

function ThresholdForm({ branchId, initial }: { branchId: string | null; initial: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const save = useUpdateRestaurantSettings(branchId);
  const { note, clear, toast } = useNoteToast();
  const submit = () => {
    const n = normalizeThreshold(value);
    if (Number.isNaN(n)) return toast.error(t("acct.exp.threshold.invalid"));
    save.mutate(
      { expenseApprovalThreshold: n },
      {
        onSuccess: () => toast.success(t("acct.exp.threshold.saved")),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : t("acct.error")),
      },
    );
  };
  return (
    <Card className="flex flex-col gap-2 p-4">
      <label className="text-sm font-medium" htmlFor="expense-threshold">{t("acct.exp.threshold.title")}</label>
      <p className="text-xs text-muted-foreground">{t("acct.exp.threshold.help")}</p>
      {note && <StatusNote note={note} onClear={clear} />}
      <div className="flex gap-2">
        <Input id="expense-threshold" className="w-40" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button onClick={submit} disabled={save.isPending}>{t("acct.exp.threshold.save")}</Button>
      </div>
    </Card>
  );
}
