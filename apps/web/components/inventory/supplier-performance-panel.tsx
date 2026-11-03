"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/ui/query-error";
import { useSupplierPerformance } from "@/hooks/use-inventory";
import { formatCurrency } from "@/lib/format";
import {
  describePerformance,
  formatLeadTime,
  formatOnTimeRate,
  onTimeTone,
} from "@/lib/supplier-performance";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  good: "text-emerald-600",
  warn: "text-amber-600",
  bad: "text-destructive",
  none: "text-muted-foreground",
} as const;

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-3" data-testid="supplier-metric">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-lg font-semibold text-foreground", className)}>{value}</span>
    </div>
  );
}

export function SupplierPerformancePanel({
  branchId,
  supplierId,
}: {
  branchId: string | null;
  supplierId: string;
}) {
  const { data, isLoading, error, refetch, isFetching } = useSupplierPerformance(branchId, supplierId);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 p-4" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <QueryError error={error} what="supplier performance" onRetry={() => refetch()} retrying={isFetching} />
      </div>
    );
  }
  if (!data) return null;

  const { hasDeliveries } = describePerformance(data);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Purchase orders" value={String(data.totalPurchaseOrders)} />
        <Metric label="Total spend" value={formatCurrency(data.totalSpend)} />
        <Metric
          label="On-time delivery"
          value={formatOnTimeRate(data.onTimeDeliveryRate)}
          className={TONE_CLASS[onTimeTone(data.onTimeDeliveryRate)]}
        />
        <Metric label="Avg lead time" value={formatLeadTime(data.avgLeadTimeDays)} />
      </div>
      {!hasDeliveries && (
        <p className="text-sm text-muted-foreground" data-testid="supplier-no-deliveries">
          No deliveries received yet. On-time and lead-time figures appear after the first goods receipt.
        </p>
      )}
    </div>
  );
}
