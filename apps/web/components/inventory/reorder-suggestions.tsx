"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreatePurchaseRequest,
  useReorderSuggestions,
  type ReorderSuggestionGroup,
} from "@/hooks/use-inventory";
import { buildPurchaseRequest } from "@/lib/reorder";
import { useI18n } from "@/lib/i18n/context";

function GroupTable({ group, branchId }: { group: ReorderSuggestionGroup; branchId: string | null }) {
  const { t } = useI18n();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const create = useCreatePurchaseRequest(branchId);
  const body = buildPurchaseRequest(group, edits);
  const key = group.supplierId ?? "none";

  return (
    <div data-testid={`reorder-group-${key}`}>
      <div className="flex items-center justify-between px-4 py-2">
        <p className="text-sm font-medium text-foreground">
          {group.supplierName ?? t("inv.reorder.noSupplier")}
        </p>
        <Button
          size="sm"
          disabled={body.items.length === 0 || create.isPending}
          onClick={() => create.mutate(body, { onSuccess: () => setEdits({}) })}
        >
          {t("inv.reorder.create")}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inv.reorder.ingredient")}</TableHead>
            <TableHead className="text-right">{t("inv.reorder.stock")}</TableHead>
            <TableHead className="text-right">{t("inv.reorder.quantity")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.suggestions.map((s) => (
            <TableRow key={s.ingredientId}>
              <TableCell className="font-medium text-foreground">{s.name}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {s.currentStock} {s.unit}
              </TableCell>
              <TableCell className="text-right">
                <Input
                  aria-label={t("inv.reorder.quantityFor", { name: s.name })}
                  inputMode="decimal"
                  className="ml-auto h-8 w-24 text-right tabular-nums"
                  value={edits[s.ingredientId] ?? String(s.suggestedQuantity)}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [s.ingredientId]: e.target.value }))}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ReorderSuggestionsSection({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data, isLoading } = useReorderSuggestions(branchId);

  return (
    <Card className="overflow-hidden p-0" data-testid="reorder-suggestions">
      <div className="border-b border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{t("inv.reorder.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("inv.reorder.subtitle")}</p>
      </div>
      {isLoading ? (
        <div className="p-4">
          <Skeleton className="h-10 rounded-lg" />
        </div>
      ) : data && data.groups.length > 0 ? (
        data.groups.map((g) => <GroupTable key={g.supplierId ?? "none"} group={g} branchId={branchId} />)
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("inv.reorder.empty")}</p>
      )}
    </Card>
  );
}
