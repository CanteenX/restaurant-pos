import { z } from 'zod';

export type ReplyTarget = { address: string; verified: boolean };
type Origin = Readonly<{ claimedSender: string | null; verifiedSender: string | null }>;

const canonicalAddress = z.string().max(254).pipe(z.email()).refine((address) => {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain === domain.toLowerCase();
});

/** Resolve only the original accepted receipt. A later message cannot supply a fallback destination. */
export function replyTarget(origin: Origin | null): ReplyTarget | null {
  if (!origin) return null;
  const address = canonicalAddress.safeParse(origin.claimedSender);
  if (!address.success || (origin.verifiedSender !== null && origin.verifiedSender !== address.data)) return null;
  return { address: address.data, verified: origin.verifiedSender !== null };
}