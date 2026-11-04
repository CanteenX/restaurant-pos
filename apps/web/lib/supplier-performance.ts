import type { TranslationKey } from "@/lib/i18n/context";
export interface SupplierPerformanceLike {
  totalPurchaseOrders: number;
  onTimeDeliveryRate: number | null;
  avgLeadTimeDays: number | null;
}

export type OnTimeTone = "good" | "warn" | "bad" | "none";

/** On-time rate arrives as a 0-100 number; null means no tracked deliveries. */
export function formatOnTimeRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate)}%`;
}

export function formatLeadTime(days: number | null): string {
  if (days === null) return "—";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function onTimeTone(rate: number | null): OnTimeTone {
  if (rate === null) return "none";
  if (rate >= 90) return "good";
  if (rate >= 70) return "warn";
  return "bad";
}

/** A supplier has "deliveries" once any lead-time or on-time data exists. */
export function describePerformance(p: SupplierPerformanceLike): { hasDeliveries: boolean } {
  return { hasDeliveries: p.onTimeDeliveryRate !== null || p.avgLeadTimeDays !== null };
}

/** Dictionary key for the text label shown next to the on-time %, or null with no data. */
export function onTimeLabelKey(rate: number | null): TranslationKey | null {
  const tone = onTimeTone(rate);
  if (tone === "none") return null;
  return tone === "good" ? "inventory.supplier.good" : tone === "warn" ? "inventory.supplier.atRisk" : "inventory.supplier.poor";
}
