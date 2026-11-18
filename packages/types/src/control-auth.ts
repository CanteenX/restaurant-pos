import { z } from 'zod';

// An unpadded 32-byte base64url value has two zero padding bits in its last character.
const token = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const controlChallengeSchema = z.strictObject({
  enrollmentProof: token.optional(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(72).refine((s) => new TextEncoder().encode(s).length <= 72),
});
export const controlFactorSchema = z.strictObject({
  challenge: token,
  code: z.string().regex(/^(?:[0-9]{6}|[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})$/),
});
