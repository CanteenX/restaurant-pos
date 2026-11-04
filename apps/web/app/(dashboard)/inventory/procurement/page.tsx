"use client";

import { MoreHorizontal } from "lucide-react";
import { CreateInvoiceDialog } from "@/components/inventory/create-invoice-dialog";
import { CreatePurchaseRequestDialog } from "@/components/inventory/create-purchase-request-dialog";
import { CreateQuotationDialog } from "@/components/inventory/create-quotation-dialog";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { RecordPaymentDialog } from "@/components/inventory/record-payment-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  usePurchaseRequests,
  useQuotations,
  useSupplierInvoices,
  useUpdatePurchaseRequestStatus,
  useUpdateQuotationStatus,
  type PurchaseRequest,
  type SupplierInvoice,
  type SupplierQuotation,
} from "@/hooks/use-inventory";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

const REQUEST_NEXT: Record<PurchaseRequest["status"], PurchaseRequest["status"][]> = {
  DRAFT: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
  CONVERTED: [],
};

const QUOTATION_NEXT: Record<SupplierQuotation["status"], SupplierQuotation["status"][]> = {
  DRAFT: ["RECEIVED"],
  RECEIVED: ["ACCEPTED", "REJECTED"],
  ACCEPTED: [],
  REJECTED: [],
};

const INVOICE_BADGE: Record<SupplierInvoice["status"], "default" | "secondary" | "outline" | "destructive"> = {
  UNPAID: "outline",
  PARTIALLY_PAID: "secondary",
  PAID: "default",
  CANCELLED: "destructive",
};

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function PurchaseRequestsSection({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: requests, isLoading } = usePurchaseRequests(branchId);
  const updateStatus = useUpdatePurchaseRequestStatus(branchId);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("inv.pr.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("inv.pr.subtitle")}</p>
        </div>
        <CreatePurchaseRequestDialog branchId={branchId} />
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : requests && requests.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inv.pr.number")}</TableHead>
              <TableHead>{t("inv.pr.requestedBy")}</TableHead>
              <TableHead>{t("inv.col.status")}</TableHead>
              <TableHead className="text-right">{t("inv.col.items")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((r) => {
              const next = REQUEST_NEXT[r.status];
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-medium text-foreground">{r.requestNumber}</TableCell>
                  <TableCell className="text-muted-foreground">{r.requestedBy.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t(`inv.status.${r.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.items.length}</TableCell>
                  <TableCell className="w-10">
                    {next.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {next.map((status) => (
                            <DropdownMenuItem
                              key={status}
                              onClick={() => updateStatus.mutate({ id: r.id, status })}
                            >
                              {t("inv.moveTo", { status: t(`inv.status.${status}`).toLowerCase() })}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          title={t("inv.pr.empty.title")}
          description={t("inv.pr.empty.body")}
        />
      )}
    </Card>
  );
}

function QuotationsSection({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: quotations, isLoading } = useQuotations(branchId);
  const updateStatus = useUpdateQuotationStatus(branchId);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("inv.quote.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("inv.quote.subtitle")}</p>
        </div>
        <CreateQuotationDialog branchId={branchId} />
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : quotations && quotations.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inv.quote.number")}</TableHead>
              <TableHead>{t("inv.col.supplier")}</TableHead>
              <TableHead>{t("inv.col.status")}</TableHead>
              <TableHead className="text-right">{t("inv.col.items")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotations.map((q) => {
              const next = QUOTATION_NEXT[q.status];
              return (
                <TableRow key={q.id}>
                  <TableCell className="font-medium text-foreground">{q.quotationNumber}</TableCell>
                  <TableCell className="text-muted-foreground">{q.supplier.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t(`inv.status.${q.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{q.items.length}</TableCell>
                  <TableCell className="w-10">
                    {next.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {next.map((status) => (
                            <DropdownMenuItem
                              key={status}
                              onClick={() => updateStatus.mutate({ id: q.id, status })}
                            >
                              {t("inv.markAs", { status: t(`inv.status.${status}`).toLowerCase() })}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          title={t("inv.quote.empty.title")}
          description={t("inv.quote.empty.body")}
        />
      )}
    </Card>
  );
}

function SupplierInvoicesSection({ branchId }: { branchId: string | null }) {
  const { t } = useI18n();
  const { data: invoices, isLoading } = useSupplierInvoices(branchId);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("inv.invoice.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("inv.invoice.subtitle")}</p>
        </div>
        <CreateInvoiceDialog branchId={branchId} />
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : invoices && invoices.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inv.invoice.number")}</TableHead>
              <TableHead>{t("inv.col.supplier")}</TableHead>
              <TableHead>{t("inv.col.status")}</TableHead>
              <TableHead className="text-right">{t("inv.col.total")}</TableHead>
              <TableHead className="text-right">{t("inv.invoice.paid")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell className="font-medium text-foreground">{inv.invoiceNumber}</TableCell>
                <TableCell className="text-muted-foreground">{inv.supplier.name}</TableCell>
                <TableCell>
                  <Badge variant={INVOICE_BADGE[inv.status]}>{t(`inv.status.${inv.status}`)}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(Number(inv.totalAmount))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(Number(inv.amountPaid))}
                </TableCell>
                <TableCell className="w-32">
                  {(inv.status === "UNPAID" || inv.status === "PARTIALLY_PAID") && (
                    <RecordPaymentDialog branchId={branchId} invoice={inv} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          title={t("inv.invoice.empty.title")}
          description={t("inv.invoice.empty.body")}
        />
      )}
    </Card>
  );
}

export default function ProcurementPage() {
  const { t } = useI18n();
  const { branchId } = useBranch();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("inv.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("inv.subtitle")}
        </p>
      </div>

      <InventoryTabs />

      <div className="flex flex-col gap-6">
        <PurchaseRequestsSection branchId={branchId} />
        <QuotationsSection branchId={branchId} />
        <SupplierInvoicesSection branchId={branchId} />
      </div>
    </div>
  );
}
