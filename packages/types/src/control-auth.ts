import { z } from 'zod';

export const controlChallengeSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(72).refine((s) => new TextEncoder().encode(s).length <= 72),
});
export const controlFactorSchema = z.strictObject({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^(?:[0-9]{6}|[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})$/),
});
