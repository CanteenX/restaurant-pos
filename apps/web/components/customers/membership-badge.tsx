"use client";

import { Crown } from "lucide-react";
import { useCustomerMembership } from "@/hooks/use-memberships";
import { benefitSummary } from "@/lib/membership-format";

/** Tier name and benefit for a customer; renders nothing if they have no current tier. */
export function MembershipBadge({ branchId, customerId }: { branchId: string | null; customerId: string }) {
  const { data } = useCustomerMembership(branchId, customerId);
  const b = data?.benefit;
  if (!b?.tierId) return null;
  const summary = benefitSummary(b);
  return (
    <span
      data-testid="membership-badge"
      className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
    >
      <Crown className="h-3 w-3" aria-hidden />
      {b.tierName}
      {summary && <span className="font-normal text-muted-foreground">· {summary}</span>}
    </span>
  );
}
