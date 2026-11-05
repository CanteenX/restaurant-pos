import { z } from "zod";

// Multi-branch sync boundaries (#82). Each change's own shape is checked per
// change on the server (sync/outbox.ts assertWellFormed), so one malformed
// change is reported as a conflict instead of failing the whole page.

/** Largest push page a server accepts (clients send 200). */
export const SYNC_PUSH_MAX = 1000;

export const syncPushSchema = z.object({
  // Ignored by the server: the device id comes from the peer's key (G12).
  device: z.string().max(100).optional(),
  changes: z.array(z.record(z.string(), z.unknown())).max(SYNC_PUSH_MAX),
});
export type SyncPushDto = z.infer<typeof syncPushSchema>;

export const syncPullQuerySchema = z.object({
  since: z.string().regex(/^\d{1,19}$/, "since must be an outbox position"),
  device: z.string().max(100).optional(),
});
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;

/** A branch install asking HQ for its own key (bootstrap key auth). */
export const syncRegisterSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "device id must be 8-64 letters, digits, - or _"),
  name: z.string().trim().min(1).max(80),
  // Empty: HQ picks its only branch, or answers with the list to choose from.
  branchIds: z.array(z.string().min(1).max(64)).max(50).default([]),
  // Re-registering an id HQ already has proves the key issued for it.
  currentKey: z.string().min(1).max(128).optional(),
});
export type SyncRegisterDto = z.infer<typeof syncRegisterSchema>;

export const syncConnectionSchema = z.object({
  serverUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s]+$/i, "Enter the server address, e.g. https://orders.example.com"),
  apiKey: z.string().trim().min(16, "Sync key must be at least 16 characters"),
});
export type SyncConnectionDto = z.infer<typeof syncConnectionSchema>;

export const syncSettingsSchema = syncConnectionSchema.extend({
  mode: z.enum(["adopt", "merge"], { message: "mode must be adopt or merge" }),
  // Branches this install runs. Optional when the choice is unambiguous.
  branchIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});
export type SyncSettingsDto = z.infer<typeof syncSettingsSchema>;
