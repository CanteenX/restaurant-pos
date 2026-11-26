import { z } from 'zod';
import { controlStaffId } from './control-auth';

const positiveInt = z.number().int().min(1).max(2_147_483_647);
const canonicalDate = z.iso.datetime({ precision: 3 }).regex(/^(?!0000)/).transform((value) => new Date(value));
export const servicePlanOperation = z.enum(['assign', 'renew', 'cancel']);
export const servicePlanKey = z.strictObject({ requestKey: controlStaffId });
export const servicePlanDates = servicePlanKey.extend({
  planCode: z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/),
  planVersion: positiveInt,
  startsAt: canonicalDate,
  endsAt: canonicalDate,
}).refine(({ startsAt, endsAt }) => startsAt < endsAt);

export const servicePlanPage = z.strictObject({
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(50)).default(25),
  cursor: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(positiveInt).optional(),
});
