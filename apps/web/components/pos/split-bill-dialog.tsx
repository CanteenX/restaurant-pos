"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusNote, useStatusNote } from "@/components/ui/status-note";
import { copyText } from "@/lib/copy-text";
import { formatCurrency } from "@/lib/format";
import { guestShares, unassignedLines, type Assignments } from "@/lib/split-bill";

export interface SplitBillLine {
  id: string;
  name: string;
  quantity: number;
  total: number;
}

// Split one bill between guests. Every guest's share is a plain number the
// cashier then records as an ordinary part payment: the server still prices
// and validates the bill, nothing here is trusted.
export function SplitBillDialog({
  open,
  onOpenChange,
  lines,
  bill,
  balanceDue,
  onPickAmount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: SplitBillLine[];
  bill: { subtotal: number; taxAmount: number; totalDue: number };
  balanceDue: number;
  onPickAmount: (amount: number) => void;
}) {
  const [guestText, setGuestText] = useState("2");
  const [assignments, setAssignments] = useState<Assignments>({});
  const copyNote = useStatusNote();
  const guests = Math.min(12, Math.max(2, Math.floor(Number(guestText) || 2)));

  const shares = useMemo(
    () => guestShares({ guests, lines: lines.map((l) => ({ id: l.id, total: l.total })), assignments, bill }),
    [guests, lines, assignments, bill],
  );
  const pending = unassignedLines(lines, assignments);

  const toggle = (lineId: string, guest: number) =>
    setAssignments((prev) => {
      const w = Array.from({ length: guests }, (_, g) => prev[lineId]?.[g] ?? 0);
      w[guest] = w[guest] ? 0 : 1;
      return { ...prev, [lineId]: w };
    });

  const summary = shares
    .map((s) => `Guest ${s.guest}: ${formatCurrency(s.total)} (tax ${formatCurrency(s.tax)})`)
    .join("\n");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Split bill by guest</DialogTitle>
          <DialogDescription>
            Tick who had each item. An item with several guests is shared equally. Discount, tip and
            tax are spread in proportion.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Label htmlFor="split-guests" className="text-xs text-muted-foreground">Guests</Label>
          <Input
            id="split-guests"
            type="number"
            min="2"
            max="12"
            value={guestText}
            onChange={(e) => setGuestText(e.target.value)}
            className="h-8 w-16 text-center"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="split-lines">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Item</th>
                {Array.from({ length: guests }, (_, g) => (
                  <th key={g} className="px-2 py-1 text-center font-medium">G{g + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="py-1.5 pr-2">
                    {l.quantity} × {l.name}
                    <span className="ml-2 text-xs tabular-nums text-muted-foreground">{formatCurrency(l.total)}</span>
                  </td>
                  {Array.from({ length: guests }, (_, g) => (
                    <td key={g} className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`${l.name} for guest ${g + 1}`}
                        checked={(assignments[l.id]?.[g] ?? 0) > 0}
                        onChange={() => toggle(l.id, g)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pending.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {pending.length} item{pending.length === 1 ? "" : "s"} not assigned yet — shared equally for now.
          </p>
        )}

        <ul className="flex flex-col gap-2" data-testid="split-shares">
          {shares.map((s) => (
            <li key={s.guest} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <span className="text-sm">
                Guest {s.guest}
                <span className="ml-2 text-xs text-muted-foreground">tax {formatCurrency(s.tax)}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-semibold tabular-nums" data-testid={`split-share-${s.guest}`}>
                  {formatCurrency(s.total)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onPickAmount(Math.min(s.total, balanceDue));
                    onOpenChange(false);
                  }}
                >
                  Pay
                </Button>
              </span>
            </li>
          ))}
        </ul>

        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            const ok = await copyText(summary);
            copyNote.show(ok ? "success" : "error", ok ? "Summary copied" : "Could not copy. Select the amounts and copy them manually.");
          }}
        >
          Copy per-guest summary
        </Button>
        <StatusNote note={copyNote.note} onClear={copyNote.clear} />
      </DialogContent>
    </Dialog>
  );
}
