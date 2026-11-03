import { z } from "zod";

// Membership tiers (e.g. Silver/Gold) and customer enrolments. Benefits are
// looked up server-side only; clients never send a discount or multiplier
// that is trusted.

/** Tier fields without defaults, so a partial update only carries what was sent. */
const membershipTierFields = z.object({
  name: z.string().trim().min(1).max(60),
  /** Higher rank = better tier. An upgrade must move to a higher rank. */
  rank: z.number().int().min(0).max(1000),
  /** Bill discount the tier grants, 0-100 (two decimals). */
  discountPercent: z.number().min(0).max(100).multipleOf(0.01),
  /** Loyalty points earned are multiplied by this (1 = normal). */
  pointsMultiplier: z.number().min(1).max(10).multipleOf(0.01),
  /** How long an enrolment lasts; omit for no expiry. */
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  description: z.string().trim().max(300).optional(),
  active: z.boolean(),
});

export const membershipTierSchema = membershipTierFields.extend({
  discountPercent: membershipTierFields.shape.discountPercent.default(0),
  pointsMultiplier: membershipTierFields.shape.pointsMultiplier.default(1),
  active: membershipTierFields.shape.active.default(true),
});
export type MembershipTierDto = z.infer<typeof membershipTierSchema>;

/** PATCH: only the fields sent are written; omitted fields keep their value. */
export const membershipTierUpdateSchema = membershipTierFields
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type MembershipTierUpdateDto = z.infer<
  typeof membershipTierUpdateSchema
>;

export const membershipEnrolSchema = z.object({
  tierId: z.string().min(1),
});
export type MembershipEnrolDto = z.infer<typeof membershipEnrolSchema>;

/** Every per-customer membership route is scoped to a branch the caller owns. */
export const membershipBranchQuerySchema = z.object({
  branchId: z.string().trim().min(1, "branchId is required"),
});
export type MembershipBranchQueryDto = z.infer<
  typeof membershipBranchQuerySchema
>;

/** What a customer's current membership entitles them to. */
export interface MembershipBenefit {
  tierId: string | null;
  tierName: string | null;
  discountPercent: number;
  pointsMultiplier: number;
  expiresAt: string | null;
}
