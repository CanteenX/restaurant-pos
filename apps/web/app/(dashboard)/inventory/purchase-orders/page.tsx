"use client";

import Link from "next/link";
import { CreatePoDialog } from "@/components/inventory/create-po-dialog";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
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
import { usePurchaseOrders, type PurchaseOrder } from "@/hooks/use-inventory";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

const STATUS_VARIANT: Record<PurchaseOrder["status"], "default" | "secondary" | "outline" | "destructive"> = {
  DRAFT: "secondary",
  SENT: "outline",
  PARTIALLY_RECEIVED: "outline",
  RECEIVED: "default",
  CANCELLED: "destructive",
};

export default function PurchaseOrdersPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();
  const { data: orders, isLoading } = usePurchaseOrders(branchId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("inv.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("inv.subtitle")}
          </p>
        </div>
        <CreatePoDialog branchId={branchId} />
      </div>

      <InventoryTabs />

      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : orders && orders.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("inv.po.number")}</TableHead>
                <TableHead>{t("inv.col.supplier")}</TableHead>
                <TableHead>{t("inv.col.status")}</TableHead>
                <TableHead className="text-right">{t("inv.col.items")}</TableHead>
                <TableHead className="text-right">{t("inv.col.total")}</TableHead>
                <TableHead>{t("inv.po.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((po) => (
                <TableRow key={po.id} className="cursor-pointer" data-href={po.id}>
                  <TableCell>
                    <Link
                      href={`/inventory/purchase-orders/${po.id}`}
                      className="font-medium text-foreground hover:underline"
                    >
                      {po.poNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{po.supplier.name}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[po.status]}>{t(`inv.status.${po.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{po.items.length}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(po.totalAmount)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(po.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("inv.po.empty.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("inv.po.empty.body")}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
