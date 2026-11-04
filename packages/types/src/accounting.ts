import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const expenseSchema = z.object({
  spentOn: isoDate,
  category: z.string().trim().min(1).max(60),
  amount: z.coerce.number().positive(),
  note: z.string().max(300).optional(),
  paidFromCash: z.boolean().default(false),
});
export type ExpenseDto = z.infer<typeof expenseSchema>;

export const EXPENSE_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// Approve / reject a PENDING expense (#74). The note is optional either way.
export const expenseDecisionSchema = z.object({
  note: z.string().trim().max(300).optional(),
});
export type ExpenseDecisionDto = z.infer<typeof expenseDecisionSchema>;

export const cashClosingSchema = z.object({
  businessDate: isoDate,
  openingFloat: z.coerce.number().min(0).default(0),
  countedCash: z.coerce.number().min(0),
  note: z.string().max(300).optional(),
});
export type CashClosingDto = z.infer<typeof cashClosingSchema>;

// Ledger names used in the owner's Tally books (Tally export, #41).
const ledgerName = z.string().trim().min(1).max(100);
export const TALLY_LEDGER_DEFAULTS = {
  sales: "Sales",
  cgstOutput: "CGST Output",
  sgstOutput: "SGST Output",
  igstOutput: "IGST Output",
  roundOff: "Round Off",
  cash: "Cash",
  card: "Card Receipts",
  upi: "UPI Receipts",
  wallet: "Wallet Receipts",
  discount: "Discount Allowed",
  serviceCharge: "Service Charge",
  partyDefault: "Cash Sales Party",
} as const;
export type TallyLedgerKey = keyof typeof TALLY_LEDGER_DEFAULTS;
export const tallyMappingSchema = z
  .object({
    sales: ledgerName,
    cgstOutput: ledgerName,
    sgstOutput: ledgerName,
    igstOutput: ledgerName,
    roundOff: ledgerName,
    cash: ledgerName,
    card: ledgerName,
    upi: ledgerName,
    wallet: ledgerName,
    discount: ledgerName,
    serviceCharge: ledgerName,
    partyDefault: ledgerName,
  })
  .partial()
  .strict()
  .refine(
    (m) => !Object.values(m).some((v) => /[<>&]/.test(v ?? "")),
    "Ledger names cannot contain < > or &",
  );
export type TallyMappingDto = z.infer<typeof tallyMappingSchema>;

// Petty cash float (#72). Amounts are positive; the server signs them.
// A PAYOUT also books one Expense (category) that is NOT paid from the till,
// so it is counted once in P&L and never against the day-close cash count.
const pettyBase = {
  businessDate: isoDate,
  reason: z.string().trim().min(1).max(200),
  receiptRef: z.string().trim().max(100).optional(),
};
// Checked after rounding to paisa, so 0.001 can't become a 0.00 entry.
const paisa = (n: number) => Math.round(n * 100) / 100;
const money = z.coerce
  .number()
  .max(10_000_000)
  .refine((n) => paisa(n) > 0, "Amount must be at least 0.01");
export const pettyCashEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("TOP_UP"),
    ...pettyBase,
    amount: money,
    // Cash moved out of the till drawer into the petty-cash box.
    fromTill: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("PAYOUT"),
    ...pettyBase,
    amount: money,
    category: z.string().trim().min(1).max(60),
  }),
  z.object({
    kind: z.literal("ADJUST"),
    ...pettyBase,
    // Signed correction (+ found, - missing); never zero.
    amount: z.coerce
      .number()
      .refine((n) => paisa(n) !== 0 && Math.abs(n) <= 10_000_000, "Non-zero amount required"),
  }),
]);
export type PettyCashEntryDto = z.infer<typeof pettyCashEntrySchema>;

export const pettyCashReconcileSchema = z.object({
  businessDate: isoDate,
  countedCash: z.coerce.number().min(0).max(10_000_000),
  note: z.string().trim().max(200).optional(),
});
export type PettyCashReconcileDto = z.infer<typeof pettyCashReconcileSchema>;
