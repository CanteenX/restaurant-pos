"use client";

import { useI18n } from "@/lib/i18n/context";
import { Percent } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusNote, useNoteToast } from "@/components/ui/status-note";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useBulkPrice, type BulkPriceResult, type MenuCategory } from "@/hooks/use-menu";

/** Change every dish price by a percentage in one go: positive raises, negative lowers. */
export function BulkPriceDialog({ branchId, categories }: { branchId: string | null; categories: MenuCategory[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [percent, setPercent] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [roundToWhole, setRoundToWhole] = useState(true);
  const [preview, setPreview] = useState<BulkPriceResult | null>(null);
  const { note, clear, toast } = useNoteToast();
  const bulk = useBulkPrice(branchId);

  const value = Number(percent);
  const valid = percent.trim() !== "" && Number.isFinite(value) && value >= -90 && value <= 500 && value !== 0;
  const dto = (previewOnly: boolean) => ({
    percent: value,
    roundToWhole,
    preview: previewOnly,
    ...(categoryId ? { categoryId } : {}),
  });
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t("menu.bulk.failed"));
  const reset = () => {
    setPreview(null);
    clear();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPercent("");
          setCategoryId("");
          reset();
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Percent className="h-3.5 w-3.5" />
        {t("menu.bulk.title")}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("menu.bulk.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {t("menu.bulk.help")}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bp-percent">{t("menu.bulk.percent")}</Label>
            <Input
              id="bp-percent"
              type="number"
              inputMode="decimal"
              step="0.5"
              min={-90}
              max={500}
              value={percent}
              onChange={(e) => {
                setPercent(e.target.value);
                reset();
              }}
              placeholder={t("menu.bulk.percentPlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bp-cat">{t("menu.bulk.which")}</Label>
            <select
              id="bp-cat"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                reset();
              }}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("menu.bulk.allDishes")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("menu.bulk.categoryOnly", { name: c.name })}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={roundToWhole}
              onChange={(e) => {
                setRoundToWhole(e.target.checked);
                reset();
              }}
              className="h-4 w-4"
            />
            {t("menu.bulk.round")}
          </label>
          {preview && (
            <div className="rounded-lg bg-secondary/40 px-3 py-2 text-sm">
              <p className="font-medium text-foreground">
                {t("menu.bulk.willChange", { count: preview.count, total: preview.total })}
              </p>
              <ul className="mt-1 text-xs text-muted-foreground">
                {preview.sample.map((s) => (
                  <li key={s.name}>
                    {s.name}: {formatCurrency(s.before)} → {formatCurrency(s.after)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <StatusNote note={note} onClear={clear} />
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={!valid || bulk.isPending}
            onClick={() => bulk.mutate(dto(true), { onSuccess: setPreview, onError: fail })}
          >
            {t("menu.bulk.preview")}
          </Button>
          <Button
            disabled={!valid || !preview || preview.count === 0 || bulk.isPending}
            onClick={() =>
              bulk.mutate(dto(false), {
                onSuccess: (r) => {
                  toast.success(t("menu.bulk.updated", { count: r.count }));
                  setOpen(false);
                },
                onError: fail,
              })
            }
          >
            {t("menu.bulk.apply", { count: preview?.count ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
