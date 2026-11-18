import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  cashClosingSchema,
  EXPENSE_STATUSES,
  expenseDecisionSchema,
  expenseSchema,
  type CashClosingDto,
  type ExpenseDecisionDto,
  type ExpenseDto,
  type ExpenseStatus,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { AuditAction } from '../../audit/audit-action';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { AccountingService } from './accounting.service';
import { TallyMappingService } from './tally-mapping.service';
import { buildTallyXml } from './tally-xml';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

@ApiTags('accounting')
@Controller('v1/accounting')
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly branchAccess: BranchAccessService,
    private readonly tallyMapping: TallyMappingService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('accounting.manage')
  @Get('expenses')
  async expenses(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('status') status?: string,
  ) {
    if (status && !EXPENSE_STATUSES.includes(status as ExpenseStatus))
      throw new BadRequestException('Unknown expense status');
    await this.access(u, branchId);
    return this.accounting.listExpenses(
      branchId,
      from,
      to,
      status as ExpenseStatus | undefined,
    );
  }

  /** Approver queue: every PENDING expense for the branch. */
  @Auth('expenses.approve')
  @Get('expenses/pending')
  async pendingExpenses(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listPendingExpenses(branchId);
  }

  @Auth('expenses.approve')
  @AuditAction('expense.approved', 'Expense')
  @Post('expenses/:id/approve')
  async approveExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(expenseDecisionSchema))
    body: ExpenseDecisionDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.decideExpense(
      branchId,
      id,
      u.id,
      'APPROVED',
      body.note,
    );
  }

  @Auth('expenses.approve')
  @AuditAction('expense.rejected', 'Expense')
  @Post('expenses/:id/reject')
  async rejectExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(expenseDecisionSchema))
    body: ExpenseDecisionDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.decideExpense(
      branchId,
      id,
      u.id,
      'REJECTED',
      body.note,
    );
  }

  @Auth('accounting.manage')
  @AuditAction('expense.created', 'Expense')
  @Post('expenses')
  @UsePipes(new ZodValidationPipe(expenseSchema))
  async createExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: ExpenseDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.createExpense(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @AuditAction('expense.deleted', 'Expense')
  @Delete('expenses/:id')
  async deleteExpense(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.deleteExpense(branchId, id);
  }

  @Auth('accounting.manage')
  @Get('closing/preview')
  async preview(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('date') date: string,
    @Query('openingFloat') openingFloat?: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.closingPreview(
      branchId,
      date,
      Number(openingFloat ?? 0) || 0,
    );
  }

  @Auth('accounting.manage')
  @Get('closing')
  async closings(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.listClosings(branchId);
  }

  @Auth('accounting.manage')
  @AuditAction('cash.closed', 'CashClosing')
  @Post('closing')
  @UsePipes(new ZodValidationPipe(cashClosingSchema))
  async close(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: CashClosingDto,
  ) {
    await this.access(u, branchId);
    return this.accounting.closeDay(branchId, u.id, body);
  }

  @Auth('accounting.manage')
  @Get('profit-loss')
  async pnl(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.profitAndLoss(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Get('gst')
  async gst(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    await this.access(u, branchId);
    return this.accounting.gstReport(branchId, from, to);
  }

  @Auth('accounting.manage')
  @Get('branches')
  branches(
    @CurrentUser() u: SessionUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.accounting.branchOverview(u.restaurantId, from, to);
  }

  /** TallyPrime voucher import file for a date range (sales, receipts, refunds). */
  @Auth('accounting.manage')
  @Get('tally-export')
  async tallyExport(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) {
      throw new BadRequestException('from and to must be YYYY-MM-DD');
    }
    await this.access(u, branchId);
    const [data, mapping] = await Promise.all([
      this.accounting.tallyExportData(branchId, from, to),
      this.tallyMapping.get(u.restaurantId),
    ]);
    const { xml } = buildTallyXml({ ...data, mapping });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tally-${from}_${to}.xml"`,
    );
    res.send(xml);
  }
}
