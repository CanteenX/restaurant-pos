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
import { issueAmountHint, parseIssueAmount } from "@/lib/gift-card-format";

export function IssueGiftCardDialog({ branchId }: { branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = useIssueGiftCard(branchId);
  const { data: customers } = useCustomers(open ? branchId : null);
  const parsed = parseIssueAmount(amount);
  const hint = issueAmountHint(amount);

  const close = () => {
    setOpen(false);
    setIssuedCode(null);
    setCopied(false);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(issuedCode ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select the code and copy it manually");
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsed === null) return;
    issue.mutate(
      { initialValue: parsed, customerId: customerId || undefined },
      {
        onSuccess: (card) => {
          setIssuedCode(card.code);
          setAmount("");
          setCustomerId("");
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not issue gift card"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger render={<Button size="sm" disabled={!branchId}>Issue gift card</Button>} />
      <DialogContent className="sm:max-w-sm">
        {issuedCode ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Card issued</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">Hand this code to the guest.</p>
            <p data-testid="issued-gift-card-code" className="rounded-lg border bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider select-all">
              {issuedCode}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCopy}>
                {copied ? "Copied" : "Copy code"}
              </Button>
              <Button type="button" onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
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
              aria-invalid={hint ? true : undefined}
              aria-describedby={hint ? "gc-amount-hint" : undefined}
            />
            {hint && (
              <p id="gc-amount-hint" role="alert" className="text-xs text-destructive">
                {hint}
              </p>
            )}
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
        )}
      </DialogContent>
    </Dialog>
  );
}
