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
import { CustomerPicker } from "@/components/pos/customer-picker";
import type { Customer } from "@/hooks/use-customers";
import { useI18n } from "@/lib/i18n/context";
import { useIssueGiftCard } from "@/hooks/use-gift-cards";
import { ApiError } from "@/lib/api";
import { issueAmountHintCode, parseIssueAmount } from "@/lib/gift-card-format";

export function IssueGiftCardDialog({ branchId }: { branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const { t } = useI18n();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = useIssueGiftCard(branchId);
  const parsed = parseIssueAmount(amount);
  const hintCode = issueAmountHintCode(amount);
  const hint = hintCode === null ? null : t(hintCode === "positive" ? "giftCards.hint.positive" : "giftCards.hint.number");

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
      toast.error(t("giftCards.copyFailed"));
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsed === null) return;
    issue.mutate(
      { initialValue: parsed, customerId: customer?.id },
      {
        onSuccess: (card) => {
          setIssuedCode(card.code);
          setAmount("");
          setCustomer(null);
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : t("giftCards.issueFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogTrigger render={<Button size="sm" disabled={!branchId}>{t("giftCards.issueButton")}</Button>} />
      <DialogContent className="sm:max-w-sm">
        {issuedCode ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("giftCards.cardIssued")}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">{t("giftCards.handCode")}</p>
            <p data-testid="issued-gift-card-code" className="rounded-lg border bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider select-all">
              {issuedCode}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCopy}>
                {copied ? t("giftCards.copied") : t("giftCards.copyCode")}
              </Button>
              <Button type="button" onClick={close}>{t("giftCards.done")}</Button>
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("giftCards.issueButton")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="gc-amount">{t("giftCards.amount")}</Label>
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
            <Label>{t("giftCards.customerOptional")}</Label>
            <CustomerPicker branchId={branchId} customer={customer} onSelect={setCustomer} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={parsed === null || issue.isPending}>
              {issue.isPending ? t("giftCards.issuing") : t("giftCards.issueCard")}
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
