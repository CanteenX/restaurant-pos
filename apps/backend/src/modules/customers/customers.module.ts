import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { ReferralsModule } from '../referrals/referrals.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { MembershipService } from './membership.service';
import { MembershipsController } from './memberships.controller';

@Module({
  imports: [ReferralsModule, AuditModule],
  controllers: [CustomersController, MembershipsController],
  providers: [CustomersService, MembershipService, BranchAccessService],
  exports: [CustomersService, MembershipService],
})
export class CustomersModule {}
