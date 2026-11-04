"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import type { IngredientUnit, WasteReason } from "@nventra/types";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIngredients, useLogWaste } from "@/hooks/use-inventory";
import { UnitSelect, usePackSizes } from "@/components/inventory/unit-select";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const REASONS: WasteReason[] = ["EXPIRED", "SPOILED", "DAMAGED", "PREP_ERROR", "OVER_PRODUCTION", "OTHER"];

export function LogWasteDialog({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [ingredientId, setIngredientId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [enteredUnit, setEnteredUnit] = useState<IngredientUnit | null>(null);
  const [reason, setReason] = useState<WasteReason>("SPOILED");
  const [notes, setNotes] = useState("");
  const { data: ingredients } = useIngredients(branchId);
  const logWaste = useLogWaste(branchId);

  const selected = ingredients?.find((i) => i.id === ingredientId);
  const packs = usePackSizes(branchId, ingredientId || null);
  const unit = enteredUnit ?? selected?.unit ?? "KG";

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingredientId || !Number(quantity)) return;
    logWaste.mutate(
      { ingredientId, quantity: Number(quantity), unit: selected && unit !== selected.unit ? unit : undefined, reason, notes: notes || undefined },
      {
        onSuccess: () => {
          toast.success(t("inv.waste.logged"));
          setOpen(false);
          setIngredientId("");
          setQuantity("");
          setEnteredUnit(null);
          setNotes("");
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("inv.waste.logFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm">{t("inv.waste.log")}</Button>} />
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("inv.waste.log")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>{t("inv.col.ingredient")}</Label>
            <Select value={ingredientId} onValueChange={(v) => {
                setIngredientId(v ?? "");
                setEnteredUnit(null);
              }}>
              <SelectTrigger>
                <SelectValue placeholder={t("inv.waste.selectIngredient")} />
              </SelectTrigger>
              <SelectContent>
                {ingredients?.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {t("inv.waste.inStock", { name: i.name, stock: i.currentStock, unit: i.unit })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="w-qty">{selected ? t("inv.transfers.quantityUnit", { unit }) : t("inv.col.quantity")}</Label>
            <Input
              id="w-qty"
              type="number"
              min="0"
              step="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
            {selected && (
              <UnitSelect base={selected.unit} packs={packs} value={unit} onChange={setEnteredUnit} quantity={quantity} />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t("inv.col.reason")}</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as WasteReason)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`inv.waste.reason.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="w-notes">{t("inv.waste.notesOptional")}</Label>
            <Input id="w-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={logWaste.isPending}>
              {logWaste.isPending ? t("inv.waste.logging") : t("inv.waste.log")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
