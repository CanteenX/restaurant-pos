import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [NotificationsModule, AuditModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, BranchAccessService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
