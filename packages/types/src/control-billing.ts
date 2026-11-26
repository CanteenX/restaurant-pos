import { z } from 'zod';
import { controlStaffId as controlResourceId } from './control-auth';

const label = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}\uD800-\uDFFF]+$/u);
const amountPaise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const posting = z.strictObject({ requestKey: controlResourceId, reference: label(120), amountPaise });
export const billingInvoiceInput = posting.extend({ description: label(1000), dueOn: z.iso.date().refine(date => !date.startsWith('0000')) });
export const billingPaymentInput = posting.extend({ method: z.enum(['bank_transfer', 'upi']) });
