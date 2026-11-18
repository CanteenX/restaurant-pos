import { Body, Controller, Get, Post, Put, UsePipes } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { setLocalBackupConfigSchema, type SessionUser } from '@nventra/types';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { LocalBackupService } from './local-backup.service';

// Same `backup.manage` gate as the S3 backups (see backup.controller.ts):
// a local backup is a full-instance dump, so even its status is sensitive.
@ApiTags('backups')
@Controller('v1/backups/local')
export class LocalBackupController {
  constructor(private readonly local: LocalBackupService) {}

  @Auth('backup.manage')
  @Get('status')
  status() {
    return this.local.status();
  }

  @Auth('backup.manage')
  @Put('config')
  @UsePipes(new ZodValidationPipe(setLocalBackupConfigSchema))
  setConfig(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.local.setConfig(user, body as never);
  }

  @Auth('backup.manage')
  @Post('run')
  run(@CurrentUser() user: SessionUser) {
    return this.local.runManual(user);
  }
}
