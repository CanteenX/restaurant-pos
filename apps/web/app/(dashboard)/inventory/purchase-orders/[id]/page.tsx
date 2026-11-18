"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { use } from "react";
import { toast } from "@/lib/toast";
import { ReceivePoDialog } from "@/components/inventory/receive-po-dialog";
import { ReturnItemsDialog } from "@/components/inventory/return-items-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  usePurchaseOrder,
  usePurchaseReturns,
  useUpdatePurchaseOrderStatus,
  type PurchaseOrderDetail,
} from "@/hooks/use-inventory";
import { ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

export default function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, plural } = useI18n();
  const { branchId } = useBranch();
  const { data: po, isLoading } = usePurchaseOrder(branchId, id);
  const updateStatus = useUpdatePurchaseOrderStatus(branchId);
  const { data: returns = [] } = usePurchaseReturns(branchId, po?.supplierId);

  if (isLoading || !po) {
    return <Skeleton className="h-96 rounded-2xl" />;
  }

  const grnIds = new Set(po.goodsReceipts.map((g) => g.id));
  const poReturns = returns.filter((r) => grnIds.has(r.goodsReceiptId));

  const send = () =>
    updateStatus.mutate(
      { id: po.id, status: "SENT" },
      {
        onSuccess: () => toast.success(t("inv.po.markedSent")),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("inv.po.updateFailed")),
      },
    );

  const cancel = () =>
    updateStatus.mutate(
      { id: po.id, status: "CANCELLED" },
      {
        onSuccess: () => toast.success(t("inv.po.cancelled")),
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("inv.po.updateFailed")),
      },
    );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/inventory/purchase-orders"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("inv.po.back")}
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{po.poNumber}</h1>
          <Badge>{t(`inv.status.${po.status}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("inv.po.createdBy", { supplier: po.supplier.name, name: po.createdBy.name, date: new Date(po.createdAt).toLocaleDateString() })}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {po.status === "DRAFT" && (
          <Button size="sm" onClick={send} disabled={updateStatus.isPending}>
            {t("inv.po.markSent")}
          </Button>
        )}
        {(po.status === "SENT" || po.status === "PARTIALLY_RECEIVED") && (
          <ReceivePoDialog branchId={branchId} po={po} />
        )}
        {(po.status === "DRAFT" || po.status === "SENT") && (
          <Button size="sm" variant="outline" onClick={cancel} disabled={updateStatus.isPending}>
            {t("inv.po.cancel")}
          </Button>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inv.col.ingredient")}</TableHead>
              <TableHead className="text-right">{t("inv.po.ordered")}</TableHead>
              <TableHead className="text-right">{t("inv.po.received")}</TableHead>
              <TableHead className="text-right">{t("inv.col.costPerUnit")}</TableHead>
              <TableHead className="text-right">{t("inv.po.lineTotal")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {po.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-medium text-foreground">
                  {item.ingredient?.name ?? item.ingredientId}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.quantityOrdered} {item.ingredient?.unit}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.quantityReceived} {item.ingredient?.unit}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(item.unitCost)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(Number(item.quantityOrdered) * Number(item.unitCost))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t("inv.col.total")}</span>
          <span className="font-semibold text-foreground">{formatCurrency(po.totalAmount)}</span>
        </div>
      </Card>

      {po.goodsReceipts.length > 0 && (
        <Card className="flex flex-col gap-3 p-5">
          <h2 className="text-[18px] font-medium text-foreground">{t("inv.po.goodsReceipts")}</h2>
          <div className="flex flex-col divide-y divide-border">
            {po.goodsReceipts.map((grn: PurchaseOrderDetail["goodsReceipts"][number]) => (
              <div key={grn.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">{grn.grnNumber}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("inv.po.receivedBy", { name: grn.receivedBy.name, date: new Date(grn.receivedAt).toLocaleDateString() })}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">{plural("inv.po.lineItems", grn.items.length)}</span>
                  <ReturnItemsDialog
                    branchId={branchId}
                    po={po}
                    grn={grn}
                    priorReturns={returns.filter((r) => r.goodsReceiptId === grn.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {poReturns.length > 0 && (
        <Card className="flex flex-col gap-3 p-5" data-testid="po-returns">
          <h2 className="text-[18px] font-medium text-foreground">{t("inv.return.list")}</h2>
          <div className="flex flex-col divide-y divide-border">
            {poReturns.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">
                    {r.returnNumber} · {r.goodsReceipt.grnNumber} · {t(`inv.return.reason.${r.reason}`)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("inv.return.by", { name: r.createdBy.name, date: new Date(r.createdAt).toLocaleDateString() })}
                  </span>
                </div>
                <span className="font-medium tabular-nums">
                  {t("inv.return.total", { amount: formatCurrency(r.totalAmount) })}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
