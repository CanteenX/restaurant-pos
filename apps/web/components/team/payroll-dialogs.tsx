"use client";

import { Printer } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { fetchSlip, useHrActions, type PayrollRunDetail, type SalarySlip } from "@/hooks/use-hr";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
type Line = PayrollRunDetail["lines"][number];

export function AdjustLineDialog({
  branchId,
  runId,
  line,
  onClose,
}: {
  branchId: string | null;
  runId: string;
  line: Line;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { adjustLine } = useHrActions(branchId);
  const { note, clear, toast } = useNoteToast();
  const [f, setF] = useState({
    allowances: String(Number(line.allowances)),
    bonus: String(Number(line.bonus)),
    advanceRecovery: String(Number(line.advanceRecovery)),
    otherDeductions: String(Number(line.otherDeductions)),
    adjustmentNote: line.adjustmentNote ?? "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    adjustLine.mutate(
      {
        runId,
        userId: line.user.id,
        dto: {
          allowances: Number(f.allowances) || 0,
          bonus: Number(f.bonus) || 0,
          advanceRecovery: Number(f.advanceRecovery) || 0,
          otherDeductions: Number(f.otherDeductions) || 0,
          adjustmentNote: f.adjustmentNote,
        },
      },
      {
        // The row behind the dialog updates itself; an error stays here, visible.
        onSuccess: onClose,
        onError: (err) => toast.error(errMsg(err, t("team.error.generic"))),
      },
    );
  };
  const num = (id: string, label: string, k: keyof typeof f, sign: "+" | "−") => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label} <span className="text-muted-foreground">({sign})</span>
      </Label>
      <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={f[k]} onChange={set(k)} />
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team.adjust.title", { name: line.user.name })}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            {num("p-allow", t("team.adjust.allowances"), "allowances", "+")}
            {num("p-bonus", t("team.adjust.bonus"), "bonus", "+")}
            {num("p-adv", t("team.adjust.advance"), "advanceRecovery", "−")}
            {num("p-other", t("team.adjust.other"), "otherDeductions", "−")}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="p-note">{t("team.adjust.note")}</Label>
            <Input id="p-note" maxLength={200} value={f.adjustmentNote} onChange={set("adjustmentNote")} />
          </div>
          <StatusNote note={note} onClear={clear} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("team.adjust.cancel")}
            </Button>
            <Button type="submit" disabled={adjustLine.isPending}>
              {adjustLine.isPending ? t("team.adjust.saving") : t("team.adjust.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PayRunDialog({
  branchId,
  runId,
  total,
  onClose,
}: {
  branchId: string | null;
  runId: string;
  total: string;
  onClose: () => void;
}) {
  const { t, formatCurrency } = useI18n();
  const { payRun } = useHrActions(branchId);
  const { note, clear, toast } = useNoteToast();
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER" | "UPI" | "OTHER">("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("team.payDialog.title")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("team.payDialog.bodyBefore")} <span className="font-medium text-foreground">{formatCurrency(total)}</span>{" "}
          {t("team.payDialog.bodyAfter")}
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-method">{t("team.payDialog.paidBy")}</Label>
            <select
              id="pay-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="h-10 rounded-lg border border-border bg-background px-2 text-sm"
            >
              <option value="BANK_TRANSFER">{t("team.payDialog.bank")}</option>
              <option value="UPI">{t("team.payDialog.upi")}</option>
              <option value="CASH">{t("team.payDialog.cash")}</option>
              <option value="OTHER">{t("team.payDialog.other")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-ref">{t("team.payDialog.reference")}</Label>
            <Input id="pay-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <StatusNote note={note} onClear={clear} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("team.payDialog.cancel")}
          </Button>
          <Button
            disabled={payRun.isPending}
            onClick={() =>
              payRun.mutate(
                { id: runId, method, reference: reference.trim() || undefined },
                {
                  onSuccess: onClose,
                  onError: (e) => toast.error(errMsg(e, t("team.error.generic"))),
                },
              )
            }
          >
            {payRun.isPending ? t("team.payDialog.saving") : t("team.payDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const day = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function slipHtml(s: SalarySlip, { t, formatCurrency }: Pick<ReturnType<typeof useI18n>, "t" | "formatCurrency">) {
  const row = (label: string, v: number) => (v ? `<tr><td>${esc(label)}</td><td class="r">${esc(formatCurrency(v))}</td></tr>` : "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t("team.slip.docTitle", { name: s.employee }))}</title>
<style>body{font:14px system-ui,sans-serif;margin:32px;color:#111}h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 6px;text-transform:uppercase;color:#555}
table{width:100%;border-collapse:collapse}td{padding:5px 0;border-bottom:1px solid #eee}.r{text-align:right}.net td{font-weight:700;border-top:2px solid #111;border-bottom:0;font-size:16px}.m{color:#555}</style></head><body>
<h1>${esc(s.employer)}</h1><div class="m">${esc(s.branch)}${s.address ? " · " + esc(s.address) : ""}</div>
<h2>${esc(t("team.slip.heading"))}</h2><div><b>${esc(s.employee)}</b></div>
<div class="m">${esc(t("team.slip.period", { start: day(s.periodStart), end: day(s.periodEnd), hours: s.hoursWorked }))}</div>
<h2>${esc(t("team.slip.earnings"))}</h2><table>${row(t("team.slip.basePay"), s.earnings.basePay)}${row(t("team.slip.tipShare"), s.earnings.tipShare)}${row(t("team.adjust.allowances"), s.earnings.allowances)}${row(t("team.adjust.bonus"), s.earnings.bonus)}</table>
<h2>${esc(t("team.slip.deductions"))}</h2><table>${row(t("team.slip.unpaidLeave"), s.deductions.unpaidLeave)}${row(t("team.adjust.advance"), s.deductions.advanceRecovery)}${row(t("team.adjust.other"), s.deductions.other)}</table>
<table style="margin-top:14px"><tr class="net"><td>${esc(t("team.slip.netPay"))}</td><td class="r">${esc(formatCurrency(s.netPay))}</td></tr></table>
${s.note ? `<p class="m">${esc(t("team.slip.note", { note: s.note }))}</p>` : ""}
<p class="m">${esc(s.status === "PAID" && s.paidAt ? (s.paymentMethod ? t("team.slip.paidOnBy", { date: day(s.paidAt), method: s.paymentMethod.replace("_", " ").toLowerCase() }) : t("team.slip.paidOn", { date: day(s.paidAt) })) : t("team.slip.unpaid", { status: s.status.toLowerCase() }))}</p>
<script>window.onload=function(){window.print()}</script></body></html>`;
}

export function SlipButton({ branchId, runId, userId }: { branchId: string | null; runId: string; userId: string }) {
  const { t, formatCurrency } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
    {failed && (
      <span role="alert" className="mr-1 text-xs text-destructive">
        {failed}
      </span>
    )}
    <Button
      size="sm"
      variant="ghost"
      className="h-8 px-2"
      disabled={busy}
      aria-label={t("team.slip.print")}
      onClick={async () => {
        // Open synchronously (a popup blocker only allows it inside the click), fill after the fetch.
        setFailed(null);
        const w = window.open("", "_blank");
        if (!w) return void setFailed(t("team.slip.popup"));
        setBusy(true);
        try {
          const slip = await fetchSlip(branchId, runId, userId);
          w.document.open();
          w.document.write(slipHtml(slip, { t, formatCurrency }));
          w.document.close();
        } catch (e) {
          w.close();
          setFailed(errMsg(e, t("team.error.generic")));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Printer className="h-4 w-4" />
    </Button>
    </>
  );
}
