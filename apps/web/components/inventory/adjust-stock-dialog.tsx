"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
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
import { useAdjustStock, type Ingredient } from "@/hooks/use-inventory";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

export function AdjustStockDialog({
  branchId,
  ingredient,
}: {
  branchId: string | null;
  ingredient: Ingredient;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const adjustStock = useAdjustStock(branchId);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(quantity);
    if (!qty || !note.trim()) return;
    adjustStock.mutate(
      { id: ingredient.id, dto: { quantity: qty, note } },
      {
        onSuccess: () => {
          toast.success(t("inv.adjust.done", { change: `${qty > 0 ? "+" : ""}${qty}`, unit: ingredient.unit }));
          setOpen(false);
          setQuantity("");
          setNote("");
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("inv.adjust.failed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm">{t("inv.adjust.trigger")}</Button>} />
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("inv.adjust.title", { name: ingredient.name })}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("inv.adjust.help", { stock: ingredient.currentStock, unit: ingredient.unit })}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="adj-qty">{t("inv.adjust.quantityChange")}</Label>
            <Input
              id="adj-qty"
              type="number"
              step="0.001"
              placeholder={t("inv.adjust.quantityPlaceholder")}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="adj-note">{t("inv.col.reason")}</Label>
            <Input
              id="adj-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("inv.adjust.reasonPlaceholder")}
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={adjustStock.isPending}>
              {adjustStock.isPending ? t("inv.saving") : t("inv.adjust.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
