import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ExpenseStatus } from '@nventra/types';

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
