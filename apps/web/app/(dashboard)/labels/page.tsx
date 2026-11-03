"use client";

import { useState } from "react";
import type { LabelLanguage, LabelSpec } from "@nventra/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBranch } from "@/hooks/use-branch";
import { api, ApiError } from "@/lib/api";
import { DOTS_PER_MM, previewLayout } from "@/lib/label-preview";
import { toast } from "@/lib/toast";

const WIDTH_MM = 50;
const HEIGHT_MM = 30;

export default function LabelsPage() {
  const { branchId } = useBranch();
  const [spec, setSpec] = useState<LabelSpec>({ title: "Sample item", price: "", barcode: "", batch: "", expiry: "" });
  const [language, setLanguage] = useState<LabelLanguage>("ZPL");
  const [copies, setCopies] = useState(1);
  const [commands, setCommands] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clean: LabelSpec = {
    title: spec.title,
    price: spec.price || undefined,
    barcode: spec.barcode || undefined,
    batch: spec.batch || undefined,
    expiry: spec.expiry || undefined,
  };
  const items = previewLayout(clean, HEIGHT_MM);
  const set = (k: keyof LabelSpec) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSpec((s) => ({ ...s, [k]: e.target.value }));

  const send = async (via?: "preview") => {
    setBusy(true);
    try {
      const q = `?branchId=${branchId ?? ""}${via ? `&via=${via}` : ""}`;
      const res = await api.post<{ commands?: string }>(`/orders/labels/print${q}`, {
        language,
        widthMm: WIDTH_MM,
        heightMm: HEIGHT_MM,
        copies,
        labels: [clean],
      });
      setCommands(res.commands ?? null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not print label");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">Labels</h1>
        <p className="text-sm text-muted-foreground">Shelf, packaging and expiry labels (ZPL / TSPL)</p>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="flex flex-col gap-3 p-4">
          <Label htmlFor="label-title">Title</Label>
          <Input id="label-title" value={spec.title} onChange={set("title")} maxLength={40} />
          <Label htmlFor="label-price">Price</Label>
          <Input id="label-price" value={spec.price ?? ""} onChange={set("price")} maxLength={20} />
          <Label htmlFor="label-barcode">Barcode</Label>
          <Input id="label-barcode" value={spec.barcode ?? ""} onChange={set("barcode")} maxLength={32} />
          <Label htmlFor="label-batch">Batch</Label>
          <Input id="label-batch" value={spec.batch ?? ""} onChange={set("batch")} maxLength={20} />
          <Label htmlFor="label-expiry">Expiry</Label>
          <Input id="label-expiry" type="date" value={spec.expiry ?? ""} onChange={set("expiry")} />
          <Label htmlFor="label-language">Printer language</Label>
          <select
            id="label-language"
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as LabelLanguage)}
          >
            <option value="ZPL">ZPL (Zebra)</option>
            <option value="TSPL">TSPL (TSC)</option>
          </select>
          <Label htmlFor="label-copies">Copies</Label>
          <Input
            id="label-copies"
            type="number"
            min={1}
            max={100}
            value={copies}
            onChange={(e) => setCopies(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
          />
          <div className="flex gap-2 pt-2">
            <Button variant="outline" disabled={busy || !spec.title.trim()} onClick={() => send("preview")}>
              Show commands
            </Button>
            <Button disabled={busy || !branchId || !spec.title.trim()} onClick={() => send()}>
              Print label
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
                <text key={i} x={it.x} y={it.y + it.h * 0.8} fontSize={it.h} fill="currentColor">
                  {it.text}
                </text>
              ) : (
                <g key={i} data-testid="label-preview-barcode">
                  <rect x={it.x} y={it.y} width={240} height={it.h} fill="currentColor" opacity={0.85} />
                  <text x={it.x} y={it.y + it.h + 18} fontSize={16} fill="currentColor">
                    {it.text}
                  </text>
                </g>
              ),
            )}
          </svg>
          {commands ? (
            <pre data-testid="label-commands" className="overflow-auto rounded bg-muted p-3 text-xs">
              {commands}
            </pre>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
