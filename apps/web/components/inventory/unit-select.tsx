"use client";

import type { IngredientUnit } from "@nventra/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIngredientConversions } from "@/hooks/use-inventory";
import { useI18n } from "@/lib/i18n/context";
import { convertPreview, enterableUnits, type PackSize } from "@/lib/unit-preview";

/** Pack sizes for an ingredient, as numbers (empty until loaded). */
export function usePackSizes(branchId: string | null, ingredientId: string | null): PackSize[] {
  const { data } = useIngredientConversions(branchId, ingredientId);
  return (data ?? []).map((c) => ({ unit: c.unit, factor: Number(c.factor) }));
}

interface UnitSelectProps {
  base: IngredientUnit;
  packs: readonly PackSize[];
  value: IngredientUnit;
  onChange: (unit: IngredientUnit) => void;
  quantity: string;
  label?: string;
}

/** Unit picker with a live "= N <base>" conversion preview. */
export function UnitSelect({ base, packs, value, onChange, quantity, label }: UnitSelectProps) {
  const { t } = useI18n();
  const units = enterableUnits(base, packs);
  const preview = value !== base && quantity !== "" ? convertPreview(Number(quantity), value, base, packs) : null;
  return (
    <div className="flex flex-col gap-1">
      <Select value={value} onValueChange={(v) => onChange(v as IngredientUnit)}>
        <SelectTrigger aria-label={label ?? t("inv.col.unit")} data-testid="unit-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {units.map((u) => (
            <SelectItem key={u} value={u}>
              {u}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {preview !== null && (
        <p className="text-xs text-muted-foreground" data-testid="unit-preview">
          {t("inv.unit.preview", { quantity: preview, unit: base })}
        </p>
      )}
    </div>
  );
}
