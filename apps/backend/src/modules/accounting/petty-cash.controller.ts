import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  pettyCashEntrySchema,
  pettyCashReconcileSchema,
  type PettyCashEntryDto,
  type PettyCashReconcileDto,
  type SessionUser,
} from '@nventra/types';
import { AuditAction } from '../../audit/audit-action';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PettyCashService } from './petty-cash.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dates = (...d: (string | undefined)[]) => {
  if (!d.every((x) => DATE_RE.test(x ?? ''))) {
    throw new BadRequestException('Dates must be YYYY-MM-DD');
  }
};

@ApiTags('accounting')
@Controller('v1/accounting/petty-cash')
export class PettyCashController {
  constructor(
    private readonly petty: PettyCashService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  private access(u: SessionUser, branchId: string) {
    return this.branchAccess.assertAccess(u.restaurantId, branchId);
  }

  @Auth('petty_cash.manage')
  @Get()
  async balance(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
  ) {
    await this.access(u, branchId);
    return this.petty.balance(branchId);
  }

  @Auth('petty_cash.manage')
  @Get('entries')
  async entries(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    dates(from, to);
    await this.access(u, branchId);
    return this.petty.listEntries(branchId, from, to);
  }

  @Auth('petty_cash.manage')
  @Get('summary')
  async summary(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Query('date') date: string,
  ) {
    dates(date);
    await this.access(u, branchId);
    return this.petty.daySummary(branchId, date);
  }

  @Auth('petty_cash.manage')
  @AuditAction('petty_cash.recorded', 'PettyCashEntry')
  @Post('entries')
  async record(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body(new ZodValidationPipe(pettyCashEntrySchema)) body: PettyCashEntryDto,
  ) {
    await this.access(u, branchId);
    return this.petty.record(branchId, u.id, body);
  }

  @Auth('petty_cash.manage')
  @AuditAction('petty_cash.reconciled', 'PettyCashEntry')
  @Post('reconcile')
  async reconcile(
    @CurrentUser() u: SessionUser,
    @Query('branchId') branchId: string,
    @Body(new ZodValidationPipe(pettyCashReconcileSchema))
    body: PettyCashReconcileDto,
  ) {
    await this.access(u, branchId);
    return this.petty.reconcile(branchId, u.id, body);
  }
}
