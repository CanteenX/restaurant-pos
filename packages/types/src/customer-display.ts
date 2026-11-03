import { z } from "zod";

// Customer-facing second screen: the till publishes what the guest should see,
// a paired display (possibly on another device) receives it over Socket.IO.

export const displayLineSchema = z.object({
  name: z.string().max(200),
  quantity: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
});

export const displayStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("cart"), lines: z.array(displayLineSchema).max(200), subtotal: z.number().nonnegative() }),
  z.object({ kind: z.literal("upi"), total: z.number().nonnegative(), uri: z.string().max(1000), payee: z.string().max(200) }),
  z.object({ kind: z.literal("paid"), total: z.number().nonnegative(), method: z.string().max(50).optional() }),
]);

// Six characters, no look-alikes (0/O, 1/I) so it can be read off a screen.
export const DISPLAY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const displayCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/, "Enter the 6-character code shown on the till");

export const displayJoinSchema = z.object({ code: displayCodeSchema });
export const displayPublishSchema = z.object({ code: displayCodeSchema, state: displayStateSchema });

export type DisplayStateDto = z.infer<typeof displayStateSchema>;
export type DisplayJoinDto = z.infer<typeof displayJoinSchema>;
export type DisplayPublishDto = z.infer<typeof displayPublishSchema>;
