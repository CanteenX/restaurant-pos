import type { MembershipBenefit } from "@nventra/types";

export interface TierLike {
  id: string;
  name: string;
  rank: number;
  active: boolean;
}

const num = (n: number) => String(Number(n.toFixed(2)));

/** "10% off · 2× points"; empty when the tier grants nothing extra. */
export function benefitSummary(b: MembershipBenefit): string {
  if (!b.tierId) return "";
  const parts: string[] = [];
  if (b.discountPercent > 0) parts.push(`${num(b.discountPercent)}% off`);
  if (b.pointsMultiplier > 1) parts.push(`${num(b.pointsMultiplier)}× points`);
  return parts.join(" · ");
}

export function expiryLabel(expiresAt: string | null, now = new Date()): string {
  if (!expiresAt) return "No expiry";
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "Expires today";
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** Active tiers ranked above the current one (all active tiers if none). */
export function upgradeTiers<T extends TierLike>(tiers: T[], currentRank: number | null): T[] {
  return tiers
    .filter((t) => t.active && (currentRank === null || t.rank > currentRank))
    .sort((a, b) => a.rank - b.rank);
}
