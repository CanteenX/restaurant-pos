"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/hooks/use-branch";
import { useIngredients } from "@/hooks/use-inventory";
import { api, ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

interface TransferView {
  branches: { id: string; name: string }[];
  history: {
    id: string;
    createdAt: string;
    fromBranchId: string;
    fromBranchName: string;
    toBranchName: string;
    ingredientName: string;
    unit: string;
    quantity: string;
    unitCost: string;
    note: string | null;
  }[];
}

export default function TransfersPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const qc = useQueryClient();
  const { data: ingredients } = useIngredients(branchId);
  const { data, isLoading } = useQuery({
    queryKey: ["transfers", branchId],
    queryFn: () => {
      return api.get<TransferView>(`/inventory/transfers?branchId=${branchId}`);
    },
    enabled: !!branchId,
  });
  const [toBranchId, setTo] = useState("");
  const [ingredientId, setIngredient] = useState("");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");

  const ingredient = ingredients?.find((i) => i.id === ingredientId);
  const send = useMutation({
    mutationFn: () =>
      api.post(`/inventory/transfers?branchId=${branchId}`, {
        toBranchId,
        ingredientId,
        quantity: Number(quantity),
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transfers"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      setQuantity("");
      setNote("");
      toast.success(t("inv.transfers.done"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("inv.transfers.failed")),
  });

  const noOtherBranch = !!data && data.branches.length === 0;
  const selectCls = "h-9 rounded-lg border border-border bg-background px-2 text-sm";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("inv.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("inv.transfers.subtitle")}</p>
      </div>
      <InventoryTabs />

      <Card className="flex flex-col gap-4 p-4">
        {noOtherBranch ? (
          <p className="text-sm text-muted-foreground">{t("inv.transfers.noBranch")}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="tr-ing" className="text-xs text-muted-foreground">{t("inv.transfers.ingredientHere")}</label>
              <select id="tr-ing" className={selectCls} value={ingredientId} onChange={(e) => setIngredient(e.target.value)}>
                <option value="">{t("inv.transfers.choose")}</option>
                {ingredients?.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.currentStock} {i.unit})</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="tr-qty" className="text-xs text-muted-foreground">{ingredient ? t("inv.transfers.quantityUnit", { unit: ingredient.unit }) : t("inv.col.quantity")}</label>
              <Input id="tr-qty" type="number" min="0" step="0.001" className="w-32" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="tr-to" className="text-xs text-muted-foreground">{t("inv.transfers.toBranch")}</label>
              <select id="tr-to" className={selectCls} value={toBranchId} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t("inv.transfers.choose")}</option>
                {data?.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="tr-note" className="text-xs text-muted-foreground">{t("inv.transfers.note")}</label>
              <Input id="tr-note" className="w-52" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button disabled={!ingredientId || !toBranchId || !(Number(quantity) > 0) || send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? t("inv.transfers.moving") : t("inv.transfers.transfer")}
            </Button>
          </div>
        )}
      </Card>

      <Card className="overflow-x-auto p-4">
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : data && data.history.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">{t("inv.transfers.when")}</th><th>{t("inv.col.ingredient")}</th><th>{t("inv.col.quantity")}</th><th>{t("inv.transfers.route")}</th><th className="text-right">{t("inv.col.costPerUnit")}</th></tr>
            </thead>
            <tbody>
              {data.history.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-1.5 whitespace-nowrap">{row.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td>{row.ingredientName}{row.note ? <span className="block text-xs text-muted-foreground">{row.note}</span> : null}</td>
                  <td className="tabular-nums">{row.quantity} {row.unit}</td>
                  <td><span className="inline-flex items-center gap-1.5">{row.fromBranchName} <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /> {row.toBranchName}</span></td>
                  <td className="text-right tabular-nums">{formatCurrency(Number(row.unitCost))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("inv.transfers.empty")}</p>
        )}
      </Card>
    </div>
  );
}
