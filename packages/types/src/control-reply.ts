import { z } from 'zod';
import { ticketNote } from './control-ticket';

export const ticketReply = ticketNote.extend({
  text: ticketNote.shape.text.refine((text) => !/[\uD800-\uDFFF]/u.test(text)),
  acknowledgeUnverified: z.literal(true).optional(),
});