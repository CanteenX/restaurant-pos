import { formatCurrency } from "./format.ts";

export type DepositParse = { ok: true; value: number | undefined } | { ok: false };

/** Parse the deposit text field: blank = none, otherwise a finite number >= 0. */
export function parseDepositInput(raw: string): DepositParse {
  const text = raw.trim();
  if (text === "") return { ok: true, value: undefined };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value };
}

/** Currency string for a stored deposit, or null when there is none to show. */
export function formatDeposit(deposit: string | null): string | null {
  if (deposit == null) return null;
  const n = Number(deposit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return formatCurrency(n);
}
