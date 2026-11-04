// Per-guest bill splitting. Pure and integer-paise based, so the guest shares
// always add up to the server's bill exactly. The server stays authoritative:
// these numbers only decide what each guest is asked to pay (sent as ordinary
// part payments), and the server still validates every payment.
//
// Rounding rule (deterministic): amounts are split in paise using the largest
// remainder method; ties go to the lowest guest number.

export interface SplitLine {
  id: string;
  /** Line total as billed (tax-inclusive). */
  total: number;
}

/** Per line: one weight per guest. [1,0] = guest 1 only; [1,1,1] = shared equally. */
export type Assignments = Record<string, number[]>;

export interface GuestShare {
  guest: number;
  subtotal: number;
  tax: number;
  total: number;
}

const toPaise = (n: number) => Math.round((n + Number.EPSILON) * 100);
const fromPaise = (p: number) => p / 100;

/** Split `amount` in proportion to `weights`; the parts always sum to `amount`. */
export function apportion(amount: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const totalPaise = toPaise(amount);
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const wSum = w.reduce((a, b) => a + b, 0);
  if (wSum === 0) {
    const out = weights.map(() => 0);
    out[0] = fromPaise(totalPaise);
    return out;
  }
  const exact = w.map((x) => (totalPaise * x) / wSum);
  const floors = exact.map((x) => Math.floor(x + 1e-9));
  let left = totalPaise - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map(fromPaise);
}

/** N equal shares; the leftover paise go to the first guests. */
export function splitEqually(total: number, guests: number): number[] {
  const n = Math.max(1, Math.floor(guests));
  return apportion(total, Array.from({ length: n }, () => 1));
}

const hasWeight = (ws: number[] | undefined) => !!ws && ws.some((x) => x > 0);

/** Ids of lines nobody has been assigned yet. */
export function unassignedLines(lines: SplitLine[], assignments: Assignments): string[] {
  return lines.filter((l) => !hasWeight(assignments[l.id])).map((l) => l.id);
}

/**
 * Each guest's share of the bill. Lines are split by their weights; lines with
 * no assignment are shared equally. Whatever separates the lines from the
 * final total (discount, loyalty, tip, delivery) and the tax are then spread
 * in proportion to each guest's line subtotal.
 */
export function guestShares(input: {
  guests: number;
  lines: SplitLine[];
  assignments: Assignments;
  bill: { subtotal: number; taxAmount: number; totalDue: number };
}): GuestShare[] {
  const n = Math.max(1, Math.floor(input.guests));
  const everyone = Array.from({ length: n }, () => 1);
  const lineParts = input.lines.map((l) => {
    const w = input.assignments[l.id];
    const weights = hasWeight(w) ? Array.from({ length: n }, (_, g) => w![g] ?? 0) : everyone;
    return apportion(l.total, weights);
  });
  const nothingAssigned = unassignedLines(input.lines, input.assignments).length === input.lines.length;
  const subtotals = nothingAssigned
    ? splitEqually(input.lines.reduce((a, l) => a + l.total, 0), n)
    : Array.from({ length: n }, (_, g) =>
        fromPaise(lineParts.reduce((a, parts) => a + toPaise(parts[g]), 0)),
      );
  const totals = apportion(input.bill.totalDue, subtotals);
  const taxes = apportion(input.bill.taxAmount, subtotals);
  return subtotals.map((subtotal, g) => ({ guest: g + 1, subtotal, tax: taxes[g], total: totals[g] }));
}

/** Guest count from the text field, kept within 2..12 (junk falls back to 2). */
export function clampGuests(text: string): number {
  return Math.min(12, Math.max(2, Math.floor(Number(text) || 2)));
}
