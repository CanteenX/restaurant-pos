export type ExpenseStatus = "PENDING" | "APPROVED" | "REJECTED";
export type StatusTone = "warning" | "success" | "danger";

const INFO: Record<ExpenseStatus, { labelKey: string; tone: StatusTone }> = {
  PENDING: { labelKey: "acct.exp.status.pending", tone: "warning" },
  APPROVED: { labelKey: "acct.exp.status.approved", tone: "success" },
  REJECTED: { labelKey: "acct.exp.status.rejected", tone: "danger" },
};

/** Badge label key + tone. A missing status (older rows) reads as approved. */
export function expenseStatusInfo(status: ExpenseStatus | undefined) {
  return INFO[status ?? "APPROVED"];
}

/** Sum of the amounts still waiting for a decision. */
export function pendingTotal(rows: { amount: string | number; status?: ExpenseStatus }[]): number {
  return Math.round(rows.filter((r) => r.status === "PENDING").reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
}

/** Threshold input -> API value: blank = approvals off (null), invalid = NaN. */
export function normalizeThreshold(input: string): number | null {
  if (input.trim() === "") return null;
  const n = Number(input);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}
