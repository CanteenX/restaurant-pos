import type { Prisma } from '@prisma/client';

/**
 * The ONE way an email address resolves to accounts, shared by password
 * login and password reset (#224 review) so both always mean the same
 * accounts. Emails are unique only per restaurant (`@@unique([restaurantId,
 * email])`), so one address can belong to several restaurants:
 *  - login tries each match, oldest first, and signs in to the one whose
 *    password fits;
 *  - reset sends one link per match, each email naming its restaurant.
 */
export const EMAIL_ACCOUNT_LIMIT = 10;

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
    take: EMAIL_ACCOUNT_LIMIT,
  };
}
