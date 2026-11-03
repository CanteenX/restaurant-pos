// Pure helpers for the gift cards page (display status, amount input parsing).

export type GiftCardStatus = "Active" | "Used up" | "Disabled";

export function giftCardStatus(card: { isActive: boolean; balance: string }): GiftCardStatus {
  if (!card.isActive) return "Disabled";
  return Number(card.balance) <= 0 ? "Used up" : "Active";
}

/** Positive amount rounded to 2 dp, or null when the input is not usable. */
export function parseIssueAmount(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return rounded > 0 ? rounded : null;
}

/** Why the Issue button is disabled for a non-empty amount, or null when blank/valid. */
export function issueAmountHint(input: string): string | null {
  if (!input.trim() || parseIssueAmount(input) !== null) return null;
  const n = Number(input.trim());
  return Number.isFinite(n) ? "Amount must be greater than 0." : "Enter the amount as a number.";
}
