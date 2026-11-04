import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  purchaseReturnSchema,
  type PurchaseReturnDto,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PurchaseReturnsService } from './purchase-returns.service';

// Purchase returns / debit notes. Same `inventory.manage` gate as goods
// receipts and supplier invoices: whoever may receive stock and record
// supplier bills may also send stock back. Every route checks the branch
// belongs to the caller's restaurant before touching data.
@ApiTags('inventory')
@Controller('v1/inventory')
export class PurchaseReturnsController {
  constructor(
    private readonly returns: PurchaseReturnsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('inventory.manage')
  @Get('purchase-returns')
  async list(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Query('supplierId') supplierId?: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.returns.listReturns(branchId, supplierId || undefined);
  }

  @Auth('inventory.manage')
  @Get('purchase-returns/:id')
  async get(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.returns.getReturn(branchId, id);
  }

  @Auth('inventory.manage')
  @Post('purchase-returns')
  async create(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body(new ZodValidationPipe(purchaseReturnSchema)) body: PurchaseReturnDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.returns.createReturn(branchId, user.id, body);
  }

  @Auth('inventory.manage')
  @Get('suppliers/:id/balance')
  async balance(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.returns.getSupplierBalance(branchId, id);
  }
}
