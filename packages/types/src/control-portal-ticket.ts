import { z } from 'zod';
import { controlStaffId } from './control-auth';
import { ticketNote } from './control-ticket';

const subject = z.string().refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
  .transform((value) => value.trim()).pipe(z.string().min(1).max(240));

export const portalTicketOpen = ticketNote.extend({ subject, outletId: controlStaffId.optional() });
export const portalTicketStaffReply = ticketNote;
