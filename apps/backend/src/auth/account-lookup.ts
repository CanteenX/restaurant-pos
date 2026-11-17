import type { Prisma } from '@prisma/client';

/**
 * The ONE way an email address resolves to an account, shared by password
 * login and password reset (#224 review) so both always mean the same
 * account. Emails are unique only per restaurant (`@@unique([restaurantId,
 * email])`), so one address can exist in several restaurants; it resolves to
 * the oldest active one (then lowest id). Login compares exactly one hash
 * (that account's, or the dummy), so its timing does not reveal how many
 * restaurants share an address; reset emails that same account.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailAccountQuery(email: string) {
  return {
    where: {
      email: { equals: normaliseEmail(email), mode: 'insensitive' },
      isActive: true,
    } satisfies Prisma.UserWhereInput,
    orderBy: [
      { createdAt: 'asc' },
      { id: 'asc' },
    ] satisfies Prisma.UserOrderByWithRelationInput[],
  };
}
