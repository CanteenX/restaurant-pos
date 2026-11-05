"use client";

import type { IngredientUnit } from "@nventra/types";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnitSelect, usePackSizes } from "@/components/inventory/unit-select";
import {
  useIngredients,
  useRecipe,
  useSetRecipe,
  useSetTracking,
  useTracking,
  type InventoryTracking,
} from "@/hooks/use-inventory";
import { ApiError } from "@/lib/api";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";

const MODES: { value: InventoryTracking; label: TranslationKey; hint: TranslationKey }[] = [
  { value: "NONE", label: "menu.stock.none", hint: "menu.stock.noneHint" },
  { value: "RECIPE", label: "menu.stock.recipe", hint: "menu.stock.recipeHint" },
  { value: "DIRECT", label: "menu.stock.direct", hint: "menu.stock.directHint" },
];

interface Line {
  ingredientId: string;
  quantity: string;
  /** Entered unit; undefined = the ingredient's base unit. */
  unit?: IngredientUnit;
}

const selectClass =
  "h-10 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground";

// Lives under the item form; saves on its own because stock mapping is an
// inventory concern (needs inventory.manage) separate from the menu fields.
// The form mounts only once the saved mapping has loaded, so its initial state
// comes straight from props instead of being synced in an effect.
export function StockTrackingSection({ branchId, itemId, isCombo }: { branchId: string | null; itemId: string; isCombo: boolean }) {
  const { t } = useI18n();
  const { data: tracking } = useTracking(branchId, itemId);
  const { data: recipe } = useRecipe(branchId, itemId);
  if (isCombo) {
    return (
      <p className="rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground">
        {t("menu.stock.comboNote")}
      </p>
    );
  }
  if (!tracking || !recipe) return null;
  return (
    <TrackingForm
      key={itemId}
      branchId={branchId}
      itemId={itemId}
      initialMode={tracking.inventoryTracking}
      initialDirectId={tracking.stockIngredientId ?? ""}
      initialDirectQty={String(tracking.stockQuantityPerSale)}
      initialLines={recipe.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: String(l.quantity) }))}
    />
  );
}

function TrackingForm({
  branchId,
  itemId,
  initialMode,
  initialDirectId,
  initialDirectQty,
  initialLines,
}: {
  branchId: string | null;
  itemId: string;
  initialMode: InventoryTracking;
  initialDirectId: string;
  initialDirectQty: string;
  initialLines: Line[];
}) {
  const { t } = useI18n();
  const { data: ingredients } = useIngredients(branchId);
  const setTracking = useSetTracking(branchId, itemId);
  const setRecipe = useSetRecipe(branchId, itemId);

  const [mode, setMode] = useState<InventoryTracking>(initialMode);
  const [directId, setDirectId] = useState(initialDirectId);
  const [directQty, setDirectQty] = useState(initialDirectQty);
  const [lines, setLines] = useState<Line[]>(initialLines);

  const base = (id: string) => ingredients?.find((i) => i.id === id)?.unit;
  const unit = (id: string) => ingredients?.find((i) => i.id === id)?.unit.toLowerCase() ?? "";
  const incomplete =
    (mode === "DIRECT" && !directId) || (mode === "RECIPE" && lines.filter((l) => l.ingredientId).length === 0);

  const save = async () => {
    try {
      if (mode === "RECIPE") {
        const clean = lines
          .filter((l) => l.ingredientId && Number(l.quantity) > 0)
          .map((l) => ({
            ingredientId: l.ingredientId,
            quantity: Number(l.quantity),
            unit: l.unit && l.unit !== base(l.ingredientId) ? l.unit : undefined,
          }));
        await setRecipe.mutateAsync(clean);
        await setTracking.mutateAsync({ inventoryTracking: "RECIPE" });
      } else if (mode === "DIRECT") {
        await setTracking.mutateAsync({
          inventoryTracking: "DIRECT",
          stockIngredientId: directId,
          stockQuantityPerSale: Number(directQty) || 1,
        });
      } else {
        await setTracking.mutateAsync({ inventoryTracking: "NONE" });
      }
      toast.success(t("menu.stock.saved"));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("menu.stock.saveFailed"));
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={t("menu.stock.title")}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{t("menu.stock.whenSold")}</h3>
        <p className="text-xs text-muted-foreground">{t(MODES.find((m) => m.value === mode)?.hint ?? "menu.stock.noneHint")}</p>
      </div>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("menu.stock.mode")}>
        {MODES.map((m) => (
          <Button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            variant={mode === m.value ? "default" : "outline"}
            size="sm"
            onClick={() => setMode(m.value)}
          >
            {t(m.label)}
          </Button>
        ))}
      </div>

      {mode === "DIRECT" && (
        <div className="grid grid-cols-[1fr_96px] gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="direct-ingredient">{t("menu.stock.direct")}</Label>
            <select id="direct-ingredient" className={selectClass} value={directId} onChange={(e) => setDirectId(e.target.value)}>
              <option value="">{t("menu.stock.choose")}</option>
              {ingredients?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="direct-qty">{t("menu.stock.perSale")} {unit(directId) && `(${unit(directId)})`}</Label>
            <Input id="direct-qty" type="number" min="0.001" step="0.001" value={directQty} onChange={(e) => setDirectQty(e.target.value)} />
          </div>
        </div>
      )}

      {mode === "RECIPE" && (
        <div className="flex flex-col gap-2">
          {lines.map((line, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_88px_88px_40px] items-start gap-2">
              <select
                aria-label={t("menu.stock.ingredient")}
                className={selectClass}
                value={line.ingredientId}
                onChange={(e) => setLines(lines.map((l, i) => (i === idx ? { ...l, ingredientId: e.target.value, unit: undefined } : l)))}
              >
                <option value="">{t("menu.stock.ingredientPlaceholder")}</option>
                {ingredients?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`${t("menu.stock.quantity")} ${unit(line.ingredientId)}`}
                type="number"
                min="0.001"
                step="0.001"
                value={line.quantity}
                onChange={(e) => setLines(lines.map((l, i) => (i === idx ? { ...l, quantity: e.target.value } : l)))}
              />
              <RecipeLineUnit
                branchId={branchId}
                ingredientId={line.ingredientId}
                base={base(line.ingredientId)}
                line={line}
                onChange={(u) => setLines(lines.map((l, i) => (i === idx ? { ...l, unit: u } : l)))}
              />
              <Button type="button" variant="ghost" size="icon" aria-label={t("menu.stock.removeIngredient")} onClick={() => setLines(lines.filter((_, i) => i !== idx))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setLines([...lines, { ingredientId: "", quantity: "1" }])}>
            <Plus className="h-4 w-4" /> {t("menu.stock.addIngredient")}
          </Button>
        </div>
      )}

      {incomplete && <p className="text-xs text-warning">{t("menu.stock.incomplete")}</p>}
      <Button type="button" size="sm" className="self-end" disabled={setTracking.isPending || setRecipe.isPending} onClick={save}>
        {t("menu.stock.save")}
      </Button>
    </section>
  );
}

function RecipeLineUnit({
  branchId,
  ingredientId,
  base,
  line,
  onChange,
}: {
  branchId: string | null;
  ingredientId: string;
  base: IngredientUnit | undefined;
  line: Line;
  onChange: (unit: IngredientUnit) => void;
}) {
  const packs = usePackSizes(branchId, ingredientId || null);
  if (!base) return <span />;
  return <UnitSelect base={base} packs={packs} value={line.unit ?? base} onChange={onChange} quantity={line.quantity} />;
}
