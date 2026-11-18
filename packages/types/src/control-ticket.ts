import { z } from 'zod';
import { controlStaffId, controlStaffPage } from './control-auth';

const ticketStatus = z.enum(['open', 'pending', 'resolved', 'closed']);
const ticketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
const scopedQueue = controlStaffPage.extend({
  status: ticketStatus.optional(), businessId: controlStaffId.optional(), outletId: controlStaffId.optional(),
});
const oldestCursor = z.string().max(61).transform((value) => value.split('~'))
  .pipe(z.tuple([z.iso.datetime({ precision: 3 }), controlStaffId]));
export const ticketListPage = z.union([
  scopedQueue.extend({ sort: z.undefined().optional() }),
  scopedQueue.extend({ sort: z.literal('oldest-unanswered'), cursor: oldestCursor.optional() }),
]).refine(({ businessId, outletId }) => !outletId || Boolean(businessId));
export const ticketMessagePage = z.strictObject({
  limit: controlStaffPage.shape.limit,
  cursor: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().max(2_147_483_647)).optional(),
});
export const ticketPatch = z.strictObject({
  businessId: controlStaffId.nullish(),
  outletId: controlStaffId.nullish(),
  ownerId: controlStaffId.nullish(),
  confirmedBusinessLink: z.literal(true).optional(),
  status: ticketStatus.optional(),
  priority: ticketPriority.optional(),
}).refine(({ confirmedBusinessLink, ...fields }) =>
  Object.values(fields).some((value) => value !== undefined) && (!confirmedBusinessLink || Boolean(fields.businessId)));
export const ticketNote = z.strictObject({
  requestKey: controlStaffId,
  text: z.string().min(1).max(4000).transform((text) => text.replace(/\r\n/g, '\n'))
    .refine((text) => text.trim().length > 0 && !/\p{Cc}/u.test(text.replace(/[\n\t]/g, ''))),
});
