import { GraphQLError } from 'graphql';
import type { z } from 'zod';

/**
 * Validate mutation arguments with the shared Zod schema (CLAUDE.md: the
 * boundary). GraphQL has already checked the types; this applies the same
 * business rules as REST. Explicit nulls (how GraphQL clients often send an
 * omitted optional) are dropped first, so `notes: null` means "no notes".
 */
export function parseArgs<S extends z.ZodType>(
  schema: S,
  args: unknown,
): z.infer<S> {
  const result = schema.safeParse(dropNulls(args));
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.join('.');
  throw new GraphQLError(field ? `${field}: ${issue.message}` : issue.message, {
    extensions: { code: 'BAD_USER_INPUT', field: field || undefined },
  });
}

export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && v !== undefined) out[k] = dropNulls(v);
  }
  return out;
}
