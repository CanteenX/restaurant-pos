import { z } from 'zod';

const status = z.enum(['active', 'suspended']);
const reason = z.string().trim().min(1).max(240).regex(/^[^\p{Cc}]+$/u);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
export const hostedAccessPatch = z.strictObject({ status, reason, requestKey: uuid });
export const hostedAccessTag = z.string().regex(/^"[^"]+"$/).transform((value) => value.slice(1, -1))
  .pipe(z.union([z.literal('0'), uuid]));

export type HostedAccessPatch = z.infer<typeof hostedAccessPatch>;
type StoredCommand = Pick<HostedAccessPatch, 'status' | 'reason'> & { actorId: string };

export function decideHostedPatch(actorId: string, patch: HostedAccessPatch, expected: string,
  current: string, prior?: StoredCommand): 'apply' | 'replay' | 'conflict' | 'stale' {
  if (prior) {
    return prior.actorId === actorId && prior.status === patch.status && prior.reason === patch.reason ? 'replay' : 'conflict';
  }
  return expected === current ? 'apply' : 'stale';
}
