"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCustomers } from "@/hooks/use-customers";
import { useIssueGiftCard } from "@/hooks/use-gift-cards";
import { ApiError } from "@/lib/api";
import { parseIssueAmount } from "@/lib/gift-card-format";

export function IssueGiftCardDialog({ branchId }: { branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [customerId, setCustomerId] = useState("");
  const issue = useIssueGiftCard(branchId);
  const { data: customers } = useCustomers(open ? branchId : null);
  const parsed = parseIssueAmount(amount);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsed === null) return;
    issue.mutate(
      { initialValue: parsed, customerId: customerId || undefined },
      {
        onSuccess: (card) => {
          toast.success(`Gift card ${card.code} issued`);
          setOpen(false);
          setAmount("");
          setCustomerId("");
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not issue gift card"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" disabled={!branchId}>Issue gift card</Button>} />
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Issue gift card</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="gc-amount">Amount</Label>
            <Input
              id="gc-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="gc-customer">Customer (optional)</Label>
            <select
              id="gc-customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
            >
              <option value="">No customer</option>
              {customers?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.phone ?? c.email ?? c.id}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={parsed === null || issue.isPending}>
              {issue.isPending ? "Issuing…" : "Issue card"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
