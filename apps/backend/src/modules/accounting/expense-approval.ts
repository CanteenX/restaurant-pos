import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ExpenseStatus } from '@nventra/types';
import type { Prisma } from '@prisma/client';

/** Permission whose holders are asked to approve large expenses. */
export const EXPENSE_APPROVE_PERMISSION = 'expenses.approve';

/**
 * Status a newly recorded expense starts in. `threshold` null = approvals
 * are off. Only amounts strictly above the threshold wait for approval.
 */
export function statusForNewExpense(
  amount: number,
  threshold: number | null,
): ExpenseStatus {
  return threshold !== null && amount > threshold ? 'PENDING' : 'APPROVED';
}

/** Only PENDING expenses can be decided, and never by whoever recorded them. */
export function assertDecision(
  expense: { status: ExpenseStatus; createdById: string },
  deciderId: string,
) {
  if (expense.status !== 'PENDING')
    throw new BadRequestException(
      `This expense is already ${expense.status.toLowerCase()}`,
    );
  if (expense.createdById === deciderId)
    throw new ForbiddenException(
      'You cannot approve or reject an expense you recorded',
    );
}

/** The restaurant's approval threshold for a branch; null = approvals off. */
export async function readApprovalThreshold(
  db: Pick<Prisma.TransactionClient, 'restaurant'>,
  branchId: string,
): Promise<number | null> {
  const r = await db.restaurant.findFirst({
    where: { branches: { some: { id: branchId } } },
    select: { expenseApprovalThreshold: true },
  });
  const t = r?.expenseApprovalThreshold;
  return t === null || t === undefined ? null : Number(t);
}

/**
 * A petty-cash payout (#192) has already left the float, so it cannot wait
 * in the approval queue. Above the threshold only an approver may pay it
 * out; it is then booked as pre-approved by them. Returns whether it was.
 */
export function assertPayoutAllowed(
  amount: number,
  threshold: number | null,
  canApprove: boolean,
): boolean {
  if (statusForNewExpense(amount, threshold) === 'APPROVED') return false;
  if (!canApprove)
    throw new ForbiddenException(
      'This payout is above the expense approval threshold — ask someone who can approve expenses to record it',
    );
  return true;
}
