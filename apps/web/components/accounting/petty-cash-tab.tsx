"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePettyActions, usePettyBalance, usePettyEntries, usePettySummary } from "@/hooks/use-accounting";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { buildEntryPayload, formatMovement, reconcileHint, type PettyKind } from "@/lib/petty-cash";
import { cn } from "@/lib/utils";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const KIND_LABEL: Record<PettyKind, TranslationKey> = {
  TOP_UP: "acct.petty.kind.topUp",
  PAYOUT: "acct.petty.kind.payout",
  ADJUST: "acct.petty.kind.adjust",
};

function EntryDialog({ branchId, kind, onClose }: { branchId: string | null; kind: PettyKind | null; onClose: () => void }) {
  const { t } = useI18n();
  const { record } = usePettyActions(branchId);
  const [f, setF] = useState({ amount: "", reason: "", category: "", receiptRef: "", fromTill: false });
  const submit = () => {
    if (!kind) return;
    record.mutate(buildEntryPayload({ ...f, kind, businessDate: iso(new Date()) }), {
      onSuccess: () => {
        toast.success(t("acct.petty.saved"));
        setF({ amount: "", reason: "", category: "", receiptRef: "", fromTill: false });
        onClose();
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : t("acct.error")),
    });
  };
  const valid = Number(f.amount) !== 0 && !!f.reason.trim() && (kind !== "PAYOUT" || !!f.category.trim());
  return (
    <Dialog open={kind !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind ? t(KIND_LABEL[kind]) : ""}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("acct.petty.amount")}
            <Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("acct.petty.reason")}
            <Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </label>
          {kind === "PAYOUT" && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("acct.petty.category")}
              <Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("acct.petty.receipt")}
            <Input value={f.receiptRef} onChange={(e) => setF({ ...f, receiptRef: e.target.value })} />
          </label>
          {kind === "TOP_UP" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.fromTill} onChange={(e) => setF({ ...f, fromTill: e.target.checked })} />
              {t("acct.petty.fromTill")}
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("acct.petty.cancel")}</Button>
          <Button disabled={!valid || record.isPending} onClick={submit}>{t("acct.petty.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Reconcile({ branchId, balance }: { branchId: string | null; balance: number }) {
  const { t } = useI18n();
  const { reconcile } = usePettyActions(branchId);
  const [counted, setCounted] = useState("");
  const hint = counted === "" ? null : reconcileHint(balance, Number(counted));
  const run = () =>
    reconcile.mutate(
      { businessDate: iso(new Date()), countedCash: Number(counted) },
      {
        onSuccess: () => {
          toast.success(t("acct.petty.reconciled"));
          setCounted("");
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : t("acct.error")),
      },
    );
  return (
    <Card className="flex flex-wrap items-end gap-3 p-4" data-testid="petty-reconcile">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("acct.petty.counted")}
        <Input type="number" min="0" step="0.01" className="w-40" value={counted} onChange={(e) => setCounted(e.target.value)} />
      </label>
      <Button variant="outline" disabled={counted === "" || reconcile.isPending} onClick={run}>{t("acct.petty.reconcile")}</Button>
      {hint && (
        <p data-testid="petty-hint" className={cn("text-sm", hint.status === "match" ? "text-muted-foreground" : "text-destructive")}>
          {hint.status === "match"
            ? t("acct.petty.hint.match")
            : t(hint.status === "short" ? "acct.petty.hint.short" : "acct.petty.hint.over", { amount: formatCurrency(Math.abs(hint.variance)) })}
        </p>
      )}
    </Card>
  );
}

export function PettyCashTab({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [{ today, from }] = useState(() => {
    const now = new Date();
    return { today: iso(now), from: iso(new Date(now.getTime() - 30 * 86_400_000)) };
  });
  const [kind, setKind] = useState<PettyKind | null>(null);
  const balance = usePettyBalance(branchId);
  const summary = usePettySummary(branchId, today);
  const entries = usePettyEntries(branchId, from, today);
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-xs text-muted-foreground">{t("acct.petty.balance")}</p>
          {balance.isLoading ? <Skeleton className="h-8 w-28" /> : (
            <p className="text-2xl font-semibold" data-testid="petty-balance">{formatCurrency(balance.data?.balance ?? 0)}</p>
          )}
          {summary.data && (
            <p className="text-xs text-muted-foreground">
              {t("acct.petty.today", { topUps: formatCurrency(summary.data.topUps), payouts: formatCurrency(summary.data.payouts) })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setKind("TOP_UP")}>{t("acct.petty.addTopUp")}</Button>
          <Button variant="outline" onClick={() => setKind("PAYOUT")}>{t("acct.petty.addPayout")}</Button>
        </div>
      </Card>
      <Reconcile branchId={branchId} balance={balance.data?.balance ?? 0} />
      <Card className="overflow-x-auto p-4">
        {entries.isLoading ? <Skeleton className="h-24" /> : entries.data && entries.data.length > 0 ? (
          <table className="w-full text-sm" data-testid="petty-entries">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">{t("acct.petty.col.date")}</th><th>{t("acct.petty.col.type")}</th><th>{t("acct.petty.reason")}</th><th>{t("acct.petty.col.amount")}</th><th className="text-right">{t("acct.petty.col.balance")}</th></tr>
            </thead>
            <tbody>
              {entries.data.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="py-1.5">{e.businessDate.slice(0, 10)}</td>
                  <td>{t(KIND_LABEL[e.kind])}</td>
                  <td>{e.reason}</td>
                  <td className={Number(e.amount) < 0 ? "text-destructive" : ""}>{formatMovement(e.amount)}</td>
                  <td className="text-right">{formatCurrency(e.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted-foreground">{t("acct.petty.empty")}</p>}
      </Card>
      <EntryDialog branchId={branchId} kind={kind} onClose={() => setKind(null)} />
    </div>
  );
}
