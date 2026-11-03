"use client";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QueryError } from "@/components/ui/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { IssueGiftCardDialog } from "@/components/gift-cards/issue-gift-card-dialog";
import { useBranch } from "@/hooks/use-branch";
import { useGiftCards } from "@/hooks/use-gift-cards";
import { formatCurrency } from "@/lib/format";
import { giftCardStatus } from "@/lib/gift-card-format";

export default function GiftCardsPage() {
  const { branchId } = useBranch();
  const { data: cards, isLoading, error, refetch, isFetching } = useGiftCards(branchId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-semibold tracking-tight text-foreground">Gift cards</h1>
          <p className="text-sm text-muted-foreground">Issue cards and track their balances</p>
        </div>
        <IssueGiftCardDialog branchId={branchId} />
      </div>

      <Card className="flex flex-col divide-y divide-border p-2">
        {error ? (
          <QueryError error={error} what="gift cards" onRetry={() => refetch()} retrying={isFetching} />
        ) : isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : cards && cards.length > 0 ? (
          cards.map((c) => (
            <div key={c.id} data-testid="gift-card-row" className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex flex-col">
                <span className="font-mono text-sm font-medium text-foreground">{c.code}</span>
                <span className="text-xs text-muted-foreground">
                  Issued {new Date(c.createdAt).toLocaleDateString()} · initial {formatCurrency(c.initialValue)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-foreground">{formatCurrency(c.balance)}</span>
                <Badge variant="secondary">{giftCardStatus(c)}</Badge>
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">No gift cards yet</p>
            <p className="text-sm text-muted-foreground">Issue a card to sell prepaid credit.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
