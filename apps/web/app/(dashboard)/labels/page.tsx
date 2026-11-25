"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { LabelLanguage, LabelSpec } from "@nventra/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBranch } from "@/hooks/use-branch";
import { useIngredients } from "@/hooks/use-inventory";
import { useMenuItems } from "@/hooks/use-menu";
import { labelsFromIngredients, labelsFromMenuItems } from "@/lib/label-batch";
import { api, ApiError } from "@/lib/api";
import { DOTS_PER_MM, previewLayout } from "@/lib/label-preview";
import { toast } from "@/lib/toast";
import { useI18n } from "@/lib/i18n/context";

// The browser preview is drawn at this width; label-layout.ts on the server honours widthMm.
const WIDTH_MM = 50;
const HEIGHT_MM = 30;

export default function LabelsPage() {
  return (
    <Suspense>
      <LabelsView />
    </Suspense>
  );
}

function LabelsView() {
  const { t, plural } = useI18n();
  const { branchId } = useBranch();
  // Batch mode: /labels?source=inventory|menu prints one label per active item.
  const source = useSearchParams().get("source");
  const { data: ingredients } = useIngredients(
    source === "inventory" ? branchId : null,
  );
  const { data: menuItems } = useMenuItems(source === "menu" ? branchId : null);
  const batch = useMemo(
    () =>
      source === "inventory"
        ? labelsFromIngredients(ingredients ?? [])
        : source === "menu"
          ? labelsFromMenuItems(menuItems ?? [])
          : [],
    [source, ingredients, menuItems],
  );
  const isBatch = batch.length > 0;
  const [spec, setSpec] = useState<LabelSpec>({
    title: "",
    price: "",
    barcode: "",
    batch: "",
    expiry: "",
  });
  const [customTitle, setCustomTitle] = useState(false);
  const [language, setLanguage] = useState<LabelLanguage>("ZPL");
  const [copies, setCopies] = useState(1);
  const [commands, setCommands] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clean: LabelSpec = {
    title: customTitle ? spec.title : t("labels.sampleItem"),
    price: spec.price || undefined,
    barcode: spec.barcode || undefined,
    batch: spec.batch || undefined,
    expiry: spec.expiry || undefined,
  };
  const items = previewLayout(isBatch ? batch[0] : clean, HEIGHT_MM);
  const set =
    (k: keyof LabelSpec) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setSpec((s) => ({ ...s, [k]: e.target.value }));

  const send = async (via?: "preview") => {
    setBusy(true);
    try {
      const q = `?branchId=${branchId ?? ""}${via ? `&via=${via}` : ""}`;
      const res = await api.post<{ commands?: string }>(
        `/orders/labels/print${q}`,
        {
          language,
          widthMm: WIDTH_MM,
          heightMm: HEIGHT_MM,
          copies,
          labels: isBatch ? batch.slice(0, 200) : [clean],
        },
      );
      setCommands(res.commands ?? null);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t("labels.error"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">
          {t("labels.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("labels.subtitle")}
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="flex flex-col gap-3 p-4">
          {source === "inventory" || source === "menu" ? (
            <p
              data-testid="label-batch-note"
              className="text-sm text-muted-foreground"
            >
              {t("labels.batch.note", {
                head: plural(`labels.batch.${source}`, Math.min(batch.length, 200)),
                noActive: isBatch ? "" : t("labels.batch.noActive"),
                first200: batch.length > 200 ? t("labels.batch.first200") : "",
              })}
            </p>
          ) : null}
          <Label htmlFor="label-title">{t("labels.field.title")}</Label>
          <Input
            id="label-title"
            value={clean.title}
            onChange={(event) => {
              setCustomTitle(true);
              set("title")(event);
            }}
            maxLength={40}
          />
          <Label htmlFor="label-price">{t("labels.field.price")}</Label>
          <Input
            id="label-price"
            value={spec.price ?? ""}
            onChange={set("price")}
            maxLength={20}
          />
          <Label htmlFor="label-barcode">{t("labels.field.barcode")}</Label>
          <Input
            id="label-barcode"
            value={spec.barcode ?? ""}
            onChange={set("barcode")}
            maxLength={32}
          />
          <Label htmlFor="label-batch">{t("labels.field.batch")}</Label>
          <Input
            id="label-batch"
            value={spec.batch ?? ""}
            onChange={set("batch")}
            maxLength={20}
          />
          <Label htmlFor="label-expiry">{t("labels.field.expiry")}</Label>
          <Input
            id="label-expiry"
            type="date"
            value={spec.expiry ?? ""}
            onChange={set("expiry")}
          />
          <Label htmlFor="label-language">{t("labels.field.language")}</Label>
          <select
            id="label-language"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as LabelLanguage)}
          >
            <option value="ZPL">{"ZPL (Zebra)"}</option>
            <option value="TSPL">{"TSPL (TSC)"}</option>
          </select>
          <Label htmlFor="label-copies">{t("labels.field.copies")}</Label>
          <Input
            id="label-copies"
            type="number"
            min={1}
            max={100}
            value={copies}
            onChange={(e) =>
              setCopies(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
            }
          />
          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              disabled={busy || (!isBatch && !clean.title.trim())}
              onClick={() => send("preview")}
            >
              {t("labels.showCommands")}
            </Button>
            <Button
              disabled={busy || !branchId || (!isBatch && !clean.title.trim())}
              onClick={() => send()}
            >
              {t("labels.print")}
            </Button>
          </div>
        </Card>
        <Card className="flex flex-col gap-3 p-4">
          <svg
            data-testid="label-preview"
            viewBox={`0 0 ${WIDTH_MM * DOTS_PER_MM} ${HEIGHT_MM * DOTS_PER_MM}`}
            className="w-full rounded border border-border bg-white text-black"
          >
            {items.map((it, i) =>
              it.kind === "text" ? (
                <text
                  key={i}
                  x={it.x}
                  y={it.y + it.h * 0.8}
                  fontSize={it.h}
                  fill="currentColor"
                >
                  {it.text}
                </text>
              ) : (
                <g key={i} data-testid="label-preview-barcode">
                  <rect
                    x={it.x}
                    y={it.y}
                    width={240}
                    height={it.h}
                    fill="currentColor"
                    opacity={0.85}
                  />
                  <text
                    x={it.x}
                    y={it.y + it.h + 18}
                    fontSize={16}
                    fill="currentColor"
                  >
                    {it.text}
                  </text>
                </g>
              ),
            )}
          </svg>
          {commands ? (
            <pre
              data-testid="label-commands"
              className="overflow-auto rounded bg-muted p-3 text-xs"
            >
              {commands}
            </pre>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
