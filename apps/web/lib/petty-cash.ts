import { formatCurrency } from "./format.ts";

export type PettyKind = "TOP_UP" | "PAYOUT" | "ADJUST";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Signed movement for the entries table: "+₹500.00" / "−₹120.00". */
export function formatMovement(value: number | string): string {
  const n = round2(Number(value));
  if (n === 0) return formatCurrency(0);
  return `${n > 0 ? "+" : "−"}${formatCurrency(Math.abs(n))}`;
}

/** Close-day hint: how the physical count compares with the book balance. */
export function reconcileHint(expected: number, counted: number) {
  const variance = round2(counted - expected);
  const status = variance === 0 ? "match" : variance < 0 ? "short" : "over";
  return { variance, status } as const;
}

export interface EntryForm {
  kind: PettyKind;
  businessDate: string;
  reason: string;
  receiptRef: string;
  amount: string;
  fromTill: boolean;
  category: string;
}

/** Form state -> body for POST /accounting/petty-cash/entries (server re-validates). */
export function buildEntryPayload(f: EntryForm) {
  const common = { businessDate: f.businessDate, reason: f.reason.trim(), amount: Number(f.amount) };
  const ref = f.receiptRef.trim();
  const withRef = ref ? { receiptRef: ref } : {};
  if (f.kind === "TOP_UP") return { kind: f.kind, ...common, fromTill: f.fromTill, ...withRef };
  if (f.kind === "PAYOUT") return { kind: f.kind, ...common, category: f.category.trim(), ...withRef };
  return { kind: f.kind, ...common, ...withRef };
}
