"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/ui/query-error";
import { useSupplierPerformance } from "@/hooks/use-inventory";
import { formatCurrency } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import {
  describePerformance,
  formatOnTimeRate,
  onTimeLabelKey,
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
  const { t, plural } = useI18n();
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
        <QueryError error={error} what={t("inv.perf.what")} onRetry={() => refetch()} retrying={isFetching} />
      </div>
    );
  }
  if (!data) return null;

  const { hasDeliveries } = describePerformance(data);
  const labelKey = onTimeLabelKey(data.onTimeDeliveryRate);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label={t("inv.perf.purchaseOrders")} value={String(data.totalPurchaseOrders)} />
        <Metric label={t("inv.perf.totalSpend")} value={formatCurrency(data.totalSpend)} />
        <Metric
          label={t("inv.perf.onTime")}
          value={labelKey ? `${formatOnTimeRate(data.onTimeDeliveryRate)} · ${t(labelKey)}` : formatOnTimeRate(data.onTimeDeliveryRate)}
          className={TONE_CLASS[onTimeTone(data.onTimeDeliveryRate)]}
        />
        <Metric label={t("inv.perf.leadTime")} value={data.avgLeadTimeDays === null ? "—" : plural("inv.perf.days", data.avgLeadTimeDays)} />
      </div>
      {!hasDeliveries && (
        <p className="text-sm text-muted-foreground" data-testid="supplier-no-deliveries">
          {t("inv.perf.noDeliveries")}
        </p>
      )}
    </div>
  );
}
