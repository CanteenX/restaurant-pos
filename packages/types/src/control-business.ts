import { z } from 'zod';

const name = z.string().trim().min(1).max(160).regex(/^[^\p{Cc}]+$/u);
const timeZone = z.string().max(64).regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/).refine((zone) => {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
});
export const businessCreate = z.strictObject({ legalName: name, displayName: name });
export const outletCreate = z.strictObject({ displayName: name, timeZone });
const hasFields = (value: object) => Object.keys(value).length > 0;
export const businessPatch = businessCreate.extend({ archived: z.boolean() }).partial().refine(hasFields);
export const outletPatch = outletCreate.extend({ archived: z.boolean() }).partial().refine(hasFields);
