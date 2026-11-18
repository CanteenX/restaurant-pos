"use client";

import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMergeOrder, useOpenOrders } from "@/hooks/use-orders";
import type { RestaurantTable } from "@/hooks/use-tables";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export function MergeTableDialog({
  branchId,
  table,
  allTables,
  open,
  onOpenChange,
}: {
  branchId: string | null;
  table: RestaurantTable;
  allTables: RestaurantTable[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { data: openOrders } = useOpenOrders(branchId);
  const merge = useMergeOrder(branchId);

  const thisOrder = openOrders?.find((o) => o.tableId === table.id);
  const otherOccupiedTables = allTables.filter(
    (ot) => ot.id !== table.id && openOrders?.some((o) => o.tableId === ot.id),
  );

  const handleMerge = (otherTableId: string) => {
    const otherOrder = openOrders?.find((o) => o.tableId === otherTableId);
    if (!thisOrder || !otherOrder) return;
    merge.mutate(
      { targetOrderId: thisOrder.id, sourceOrderId: otherOrder.id },
      {
        onSuccess: () => {
          toast.success(t("tables.merge.merged", { name: table.name ?? t("tables.tableLabel", { number: table.number }) }));
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : t("tables.merge.error")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("tables.merge.title", { name: table.name ?? t("tables.tableLabel", { number: table.number }) })}
          </DialogTitle>
        </DialogHeader>

        {!thisOrder ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t("tables.merge.noOpenOrder")}
          </p>
        ) : otherOccupiedTables.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t("tables.merge.noOthers")}
          </p>
        ) : (
          <div className="flex flex-col gap-2 py-2">
            {otherOccupiedTables.map((ot) => {
              const order = openOrders?.find((o) => o.tableId === ot.id);
              return (
                <Button
                  key={ot.id}
                  variant="outline"
                  className="justify-between"
                  disabled={merge.isPending}
                  onClick={() => handleMerge(ot.id)}
                >
                  <span>{ot.name ?? t("tables.tableLabel", { number: ot.number })}</span>
                  <span className="text-muted-foreground">
                    {order && formatCurrency(order.totalAmount)}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
