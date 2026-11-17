import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { AuthModule } from '../../auth/auth.module';
import { InviteAcceptController } from './invite-accept.controller';
import { StaffInviteService } from './staff-invite.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [UsersController, InviteAcceptController],
  providers: [UsersService, StaffInviteService],
})
export class UsersModule {}
