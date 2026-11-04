import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PettyCashController } from './petty-cash.controller';
import { PettyCashService } from './petty-cash.service';
import { TallyMappingService } from './tally-mapping.service';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AccountingController, LedgerController, PettyCashController],
  providers: [
    AccountingService,
    LedgerService,
    PettyCashService,
    TallyMappingService,
    BranchAccessService,
    BranchTimeService,
  ],
  exports: [AccountingService],
})
export class AccountingModule {}
