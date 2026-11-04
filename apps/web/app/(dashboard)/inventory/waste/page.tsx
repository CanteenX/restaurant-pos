"use client";

import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { LogWasteDialog } from "@/components/inventory/log-waste-dialog";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBranch } from "@/hooks/use-branch";
import { useWasteLogs } from "@/hooks/use-inventory";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export default function WastePage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const { data: logs, isLoading } = useWasteLogs(branchId);

  const totalCost = logs?.reduce(
    (sum, l) => sum + Number(l.quantity) * Number(l.unitCostAtWaste),
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("inv.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("inv.subtitle")}
          </p>
        </div>
        <LogWasteDialog branchId={branchId} />
      </div>

      <InventoryTabs />

      {typeof totalCost === "number" && logs && logs.length > 0 && (
        <Card className="flex items-center gap-3 p-5">
          <div>
            <p className="text-xs text-muted-foreground">{t("inv.waste.totalCost")}</p>
            <p className="text-xl font-semibold tabular-nums text-destructive">
              {formatCurrency(totalCost)}
            </p>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : logs && logs.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("inv.col.ingredient")}</TableHead>
                <TableHead className="text-right">{t("inv.col.quantity")}</TableHead>
                <TableHead>{t("inv.col.reason")}</TableHead>
                <TableHead className="text-right">{t("inv.waste.cost")}</TableHead>
                <TableHead>{t("inv.waste.loggedBy")}</TableHead>
                <TableHead>{t("inv.waste.date")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-medium text-foreground">{log.ingredient.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {log.quantity} {log.ingredient.unit}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`inv.waste.reason.${log.reason}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">
                    {formatCurrency(Number(log.quantity) * Number(log.unitCostAtWaste))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{log.createdBy.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(log.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("inv.waste.empty.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("inv.waste.empty.body")}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
