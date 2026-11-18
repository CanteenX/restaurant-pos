"use client";

import { Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useApplyReferralCode, useCustomerReferrals } from "@/hooks/use-customers";
import { ApiError } from "@/lib/api";
import { isPlausibleReferralCode, normalizeReferralCode, referralStatusLabel } from "@/lib/referrals";
import { toast } from "@/lib/toast";

export function ReferralCard({ branchId, customerId }: { branchId: string | null; customerId: string }) {
  const { data, isLoading, isError } = useCustomerReferrals(branchId, customerId);
  const apply = useApplyReferralCode(branchId);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (isLoading) return <Skeleton className="h-32 rounded-2xl" />;
  if (isError || !data) return null;

  const onApply = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isPlausibleReferralCode(code)) {
      setError("Enter a valid referral code (6–12 letters or digits)");
      return;
    }
    apply.mutate(
      { customerId, code: normalizeReferralCode(code) },
      {
        onSuccess: (r) => {
          toast.success(r.referrerName ? `Referred by ${r.referrerName}` : "Referral code applied");
          setCode("");
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : "Could not apply code"),
      },
    );
  };

  return (
    <Card className="flex flex-col gap-3 p-5" data-testid="referral-card">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-[18px] font-medium text-foreground">Referrals</h2>
      </div>
      {data.usedCode ? (
        <p className="text-sm text-foreground" data-testid="referral-used">
          Referred by {data.usedCode.referrer.name ?? "a customer"} with code{" "}
          <span className="font-mono">{data.usedCode.code}</span> ·{" "}
          {referralStatusLabel(data.usedCode.status)}
        </p>
      ) : (
        <form onSubmit={onApply} className="flex flex-col gap-2">
          <label htmlFor="referral-code" className="text-xs text-muted-foreground">
            Have a referral code?
          </label>
          <div className="flex gap-2">
            <Input
              id="referral-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono uppercase"
            />
            <Button type="submit" size="sm" disabled={apply.isPending}>
              {apply.isPending ? "Applying…" : "Apply"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive" data-testid="referral-error">
              {error}
            </p>
          )}
        </form>
      )}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Customers referred
        </p>
        {data.made.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">No referrals yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col divide-y divide-border" data-testid="referral-list">
            {data.made.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                <span>{r.referred.name ?? "Customer"}</span>
                <span className="text-xs text-muted-foreground">{referralStatusLabel(r.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
