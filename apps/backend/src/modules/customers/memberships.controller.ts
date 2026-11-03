import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  membershipBranchQuerySchema,
  membershipEnrolSchema,
  membershipTierSchema,
  membershipTierUpdateSchema,
  type MembershipBranchQueryDto,
  type MembershipEnrolDto,
  type MembershipTierDto,
  type MembershipTierUpdateDto,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { MembershipService } from './membership.service';

// Tiers are defined per restaurant; enrolments hang off a branch customer.
// Reading (tiers, a customer's benefit) needs customers.manage so the POS can
// show it; anything that grants or changes a discount needs memberships.manage.
@ApiTags('memberships')
@Controller('v1')
export class MembershipsController {
  constructor(
    private readonly memberships: MembershipService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  @Auth('customers.manage')
  @Get('memberships/tiers')
  listTiers(@CurrentUser() user: SessionUser) {
    return this.memberships.listTiers(user.restaurantId);
  }

  @Auth('memberships.manage')
  @Post('memberships/tiers')
  createTier(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(membershipTierSchema)) body: MembershipTierDto,
  ) {
    return this.memberships.createTier(user.restaurantId, body);
  }

  @Auth('memberships.manage')
  @Patch('memberships/tiers/:id')
  updateTier(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(membershipTierUpdateSchema))
    body: MembershipTierUpdateDto,
  ) {
    return this.memberships.updateTier(user.restaurantId, id, body);
  }

  @Auth('customers.manage')
  @Get('customers/:id/membership')
  async summary(
    @CurrentUser() user: SessionUser,
    @Query(new ZodValidationPipe(membershipBranchQuerySchema, 'query'))
    { branchId }: MembershipBranchQueryDto,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.memberships.summary(user.restaurantId, branchId, id);
  }

  @Auth('memberships.manage')
  @Post('customers/:id/membership')
  async enrol(
    @CurrentUser() user: SessionUser,
    @Query(new ZodValidationPipe(membershipBranchQuerySchema, 'query'))
    { branchId }: MembershipBranchQueryDto,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(membershipEnrolSchema))
    body: MembershipEnrolDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.memberships.enrol(
      user.restaurantId,
      branchId,
      id,
      body.tierId,
      user.id,
    );
  }

  @Auth('memberships.manage')
  @Post('customers/:id/membership/upgrade')
  async upgrade(
    @CurrentUser() user: SessionUser,
    @Query(new ZodValidationPipe(membershipBranchQuerySchema, 'query'))
    { branchId }: MembershipBranchQueryDto,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(membershipEnrolSchema))
    body: MembershipEnrolDto,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.memberships.upgrade(
      user.restaurantId,
      branchId,
      id,
      body.tierId,
      user.id,
    );
  }

  @Auth('memberships.manage')
  @Post('customers/:id/membership/expire')
  async expire(
    @CurrentUser() user: SessionUser,
    @Query(new ZodValidationPipe(membershipBranchQuerySchema, 'query'))
    { branchId }: MembershipBranchQueryDto,
    @Param('id') id: string,
  ) {
    await this.branchAccess.assertAccess(user.restaurantId, branchId);
    return this.memberships.expire(user.restaurantId, branchId, id);
  }
}
