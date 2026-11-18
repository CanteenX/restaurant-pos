import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  applyReferralCodeSchema,
  membershipBranchQuerySchema,
  type MembershipBranchQueryDto,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { ReferralsService } from './referrals.service';

// branchId is validated at the boundary (#147): a raw @Query('branchId')
// arrives as undefined when omitted, and Prisma drops an undefined `id`
// filter, so assertAccess would pass for any branch of the restaurant.
const branchQuery = () =>
  new ZodValidationPipe(membershipBranchQuerySchema, 'query');

@ApiTags('referrals')
@Controller('v1/referrals')
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('customers.manage')
  @Get('stats')
  async stats(
    @CurrentUser() user: SessionUser,
    @Query(branchQuery()) { branchId }: MembershipBranchQueryDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.referrals.stats(user.restaurantId);
  }

  @Auth('customers.manage')
  @Get('customer/:customerId')
  async forCustomer(
    @CurrentUser() user: SessionUser,
    @Query(branchQuery()) { branchId }: MembershipBranchQueryDto,
    @Param('customerId') customerId: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.referrals.listForCustomer(user.restaurantId, customerId);
  }

  @Auth('customers.manage')
  @Post('apply')
  @UsePipes(new ZodValidationPipe(applyReferralCodeSchema))
  async apply(
    @CurrentUser() user: SessionUser,
    @Query(branchQuery()) { branchId }: MembershipBranchQueryDto,
    @Body() body: unknown,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    const dto = body as { customerId: string; code: string };
    return this.referrals.applyCode(
      user.restaurantId,
      dto.customerId,
      dto.code,
    );
  }
}
