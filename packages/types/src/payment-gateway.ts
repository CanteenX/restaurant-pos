import { z } from "zod";

// Online payment through a gateway adapter (see docs/PAYMENTS.md). The amount
// is optional: by default the server charges the order's whole balance due,
// computed from the bill, never from a client total.
export const gatewayMethodSchema = z.enum(["UPI", "CARD", "WALLET", "BANK_TRANSFER"]);
export type GatewayMethod = z.infer<typeof gatewayMethodSchema>;

export const createGatewayPaymentSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  method: gatewayMethodSchema.default("UPI"),
  // One per attempt from the till; a retry with the same key returns the same
  // attempt instead of starting a second charge.
  idempotencyKey: z.string().min(8).max(64),
  // Part payment of the balance (split bill). Must not exceed the balance due.
  amount: z.coerce.number().positive().optional(),
});
export type CreateGatewayPaymentDto = z.infer<typeof createGatewayPaymentSchema>;

export const gatewayPaymentStatusSchema = z.enum([
  "CREATED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
]);
export type GatewayPaymentStatus = z.infer<typeof gatewayPaymentStatusSchema>;
