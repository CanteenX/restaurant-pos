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
