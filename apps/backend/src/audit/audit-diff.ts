import type { Prisma } from '@prisma/client';

const norm = (v: unknown): Prisma.InputJsonValue | null => {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  return v;
};

/**
 * Before/after summary of the fields a change actually touched. Only keys
 * present in `changes` AND whose value differs are returned, so unchanged
 * and untouched fields never appear in the audit trail.
 */
export function diffFields(
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<
  string,
  { before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null }
> {
  const out: Record<
    string,
    {
      before: Prisma.InputJsonValue | null;
      after: Prisma.InputJsonValue | null;
    }
  > = {};
  for (const key of Object.keys(changes)) {
    if (changes[key] === undefined) continue;
    const b = norm(before[key]);
    const a = norm(changes[key]);
    if (JSON.stringify(b) !== JSON.stringify(a))
      out[key] = { before: b, after: a };
  }
  return out;
}
