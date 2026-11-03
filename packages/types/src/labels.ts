import { z } from "zod";

export const LABEL_LANGUAGES = ["ZPL", "TSPL"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

export const labelSpecSchema = z.object({
  /** Main text line, e.g. item name. */
  title: z.string().trim().min(1).max(40),
  /** Optional price shown as-is (already formatted, tax-inclusive). */
  price: z.string().trim().max(20).optional(),
  /** Barcode payload (Code 128). */
  barcode: z.string().trim().regex(/^[\x20-\x7e]{1,32}$/, "Barcode must be 1-32 printable ASCII characters").optional(),
  batch: z.string().trim().max(20).optional(),
  /** ISO date YYYY-MM-DD. */
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type LabelSpec = z.infer<typeof labelSpecSchema>;

export const labelPrintSchema = z.object({
  language: z.enum(LABEL_LANGUAGES).default("ZPL"),
  widthMm: z.number().int().min(20).max(120).default(50),
  heightMm: z.number().int().min(15).max(200).default(30),
  copies: z.number().int().min(1).max(100).default(1),
  labels: z.array(labelSpecSchema).min(1).max(200),
});
export type LabelPrintDto = z.infer<typeof labelPrintSchema>;
