"use client";

import { Crown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { hasPermission, useCurrentUser } from "@/hooks/use-auth";
import {
  useCustomerMembership,
  useMembershipActions,
  useMembershipTiers,
} from "@/hooks/use-memberships";
import { ApiError } from "@/lib/api";
import { benefitSummary, expiryLabel, upgradeTiers } from "@/lib/membership-format";
import { toast } from "@/lib/toast";

export function MembershipCard({ branchId, customerId }: { branchId: string | null; customerId: string }) {
  const { data: me } = useCurrentUser();
  const canManage = hasPermission(me?.user, "memberships.manage");
  const { data, isLoading, isError } = useCustomerMembership(branchId, customerId);
  const { data: tiers = [] } = useMembershipTiers();
  const { enrol, upgrade, expire } = useMembershipActions(branchId, customerId);
  const [tierId, setTierId] = useState("");

  if (isLoading) return <Skeleton className="h-32 rounded-2xl" />;
  if (isError || !data) return null;

  const { benefit, history } = data;
  const current = benefit.tierId ? tiers.find((t) => t.id === benefit.tierId) : undefined;
  const options = upgradeTiers(tiers, benefit.tierId ? (current?.rank ?? -1) : null);
  const run = (fn: () => Promise<unknown>, ok: string) =>
    fn().then(
      () => {
        toast.success(ok);
        setTierId("");
      },
      (e) => toast.error(e instanceof ApiError ? e.message : "Could not update membership"),
    );
  const selected = options.find((t) => t.id === tierId)?.id ?? options[0]?.id ?? "";

  return (
    <Card className="flex flex-col gap-3 p-5" data-testid="membership-card">
      <div className="flex items-center gap-2">
        <Crown className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-[18px] font-medium text-foreground">Membership</h2>
      </div>
      {benefit.tierId ? (
        <p className="text-sm text-foreground">
          <span className="text-xl font-semibold">{benefit.tierName}</span>
          <span className="text-muted-foreground">
            {[benefitSummary(benefit), expiryLabel(benefit.expiresAt)].filter(Boolean).map((s) => ` · ${s}`)}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No current membership.</p>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {options.length > 0 && (
            <>
              <select
                aria-label="Tier"
                className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
                value={selected}
                onChange={(e) => setTierId(e.target.value)}
              >
                {options.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!selected || enrol.isPending || upgrade.isPending}
                onClick={() =>
                  benefit.tierId
                    ? run(() => upgrade.mutateAsync(selected), "Membership upgraded")
                    : run(() => enrol.mutateAsync(selected), "Customer enrolled")
                }
              >
                {benefit.tierId ? "Upgrade" : "Enrol"}
              </Button>
            </>
          )}
          {benefit.tierId && (
            <Button
              size="sm"
              variant="outline"
              disabled={expire.isPending}
              onClick={() => {
                if (confirm("End this membership now?")) run(() => expire.mutateAsync(), "Membership ended");
              }}
            >
              End membership
            </Button>
          )}
        </div>
      )}
      {history.length > 0 && (
        <ul className="flex max-h-32 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border text-xs">
          {history.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2 p-2">
              <span className="text-muted-foreground">{new Date(h.startsAt).toLocaleDateString()}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{h.tier.name}</span>
              <span className="text-muted-foreground">{h.endReason ? h.endReason.toLowerCase() : "current"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
