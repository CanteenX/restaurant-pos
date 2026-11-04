"use client";

import type { PurchaseReturnReason } from "@nventra/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreatePurchaseReturn,
  type PurchaseOrderDetail,
  type PurchaseReturn,
} from "@/hooks/use-inventory";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { returnableQuantities, validateReturnQuantities } from "@/lib/purchase-return";
import { toast } from "@/lib/toast";

const REASONS: PurchaseReturnReason[] = ["DAMAGED", "WRONG_ITEM", "EXPIRED", "QUALITY", "EXCESS", "OTHER"];

type Grn = PurchaseOrderDetail["goodsReceipts"][number];

export function ReturnItemsDialog({
  branchId,
  po,
  grn,
  priorReturns,
}: {
  branchId: string | null;
  po: PurchaseOrderDetail;
  grn: Grn;
  priorReturns: PurchaseReturn[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<PurchaseReturnReason>("DAMAGED");
  const [notes, setNotes] = useState("");
  const create = useCreatePurchaseReturn(branchId);

  const limits = returnableQuantities(grn.items, priorReturns);
  const check = validateReturnQuantities(qty, limits);
  const nameOf = (ingredientId: string) =>
    po.items.find((i) => i.ingredientId === ingredientId)?.ingredient?.name ?? ingredientId;
  const unitOf = (ingredientId: string) =>
    po.items.find((i) => i.ingredientId === ingredientId)?.ingredient?.unit ?? "";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check.ok) return;
    create.mutate(
      { goodsReceiptId: grn.id, reason, notes: notes.trim() || undefined, items: check.lines },
      {
        onSuccess: () => {
          toast.success(t("inv.return.done"));
          setQty({});
          setNotes("");
          setOpen(false);
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("inv.return.failed")),
      },
    );
  };

  if (Object.values(limits).every((n) => n <= 0)) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" data-testid={`return-items-${grn.id}`}>
            {t("inv.return.trigger")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("inv.return.title", { number: grn.grnNumber })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("inv.return.help")}</p>
          <div className="flex flex-col gap-3">
            {grn.items.map((item) => {
              const max = limits[item.id] ?? 0;
              const error = check.errors[item.id];
              return (
                <div key={item.id} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between text-sm font-medium text-foreground">
                    <span>{nameOf(item.ingredientId)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("inv.return.returnable", { max, unit: unitOf(item.ingredientId) })}
                    </span>
                  </div>
                  <Label className="text-xs" htmlFor={`rq-${item.id}`}>
                    {t("inv.return.qty")}
                  </Label>
                  <Input
                    id={`rq-${item.id}`}
                    type="number"
                    min="0"
                    max={max}
                    step="0.001"
                    disabled={max <= 0}
                    value={qty[item.id] ?? ""}
                    onChange={(e) => setQty((p) => ({ ...p, [item.id]: e.target.value }))}
                    aria-invalid={!!error}
                  />
                  {error && (
                    <p className="mt-1 text-xs text-destructive" role="alert">
                      {error === "max" ? t("inv.return.tooMany", { max }) : t("inv.return.invalidQty")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="return-reason">
              {t("inv.return.reason")}
            </Label>
            <select
              id="return-reason"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value as PurchaseReturnReason)}
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`inv.return.reason.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="return-notes">
              {t("inv.return.notes")}
            </Label>
            <Input id="return-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!check.ok || create.isPending}>
              {create.isPending ? t("inv.recording") : t("inv.return.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
