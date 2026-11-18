import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailTemplatesController } from './templates/email-templates.controller';
import { EmailTemplatesService } from './templates/email-templates.service';

@Global()
@Module({
  controllers: [EmailTemplatesController],
  providers: [EmailService, EmailTemplatesService],
  exports: [EmailService, EmailTemplatesService],
})
export class EmailModule {}
