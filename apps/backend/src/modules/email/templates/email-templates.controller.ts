import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  PipeTransform,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  emailBrandingSchema,
  emailTemplateKeySchema,
  emailTemplatePreviewSchema,
  emailTemplateTestSchema,
  emailTemplateUpdateSchema,
  type EmailBrandingDto,
  type EmailTemplateKey,
  type EmailTemplatePreviewDto,
  type EmailTemplateTestDto,
  type EmailTemplateUpdateDto,
  type SessionUser,
} from '@nventra/types';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { EmailTemplatesService } from './email-templates.service';

/** Unknown template keys are a 404, like any other missing resource. */
class TemplateKeyPipe implements PipeTransform<string, EmailTemplateKey> {
  transform(value: string): EmailTemplateKey {
    const parsed = emailTemplateKeySchema.safeParse(value);
    if (!parsed.success)
      throw new NotFoundException('Email template not found');
    return parsed.data;
  }
}

// Every route is scoped to the caller's own restaurant (user.restaurantId);
// nothing here takes a restaurant or branch id from the request.
@ApiTags('email-templates')
@Controller('v1/email-templates')
export class EmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Auth('settings.emailTemplates')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.templates.list(user.restaurantId);
  }

  @Auth('settings.emailTemplates')
  @Get('branding')
  getBranding(@CurrentUser() user: SessionUser) {
    return this.templates.getBranding(user.restaurantId);
  }

  @Auth('settings.emailTemplates')
  @Put('branding')
  updateBranding(
    @CurrentUser() user: SessionUser,
    @Body(new ZodValidationPipe(emailBrandingSchema)) body: EmailBrandingDto,
  ) {
    return this.templates.updateBranding(user.restaurantId, user.id, body);
  }

  @Auth('settings.emailTemplates')
  @Get(':key')
  get(
    @CurrentUser() user: SessionUser,
    @Param('key', TemplateKeyPipe) key: EmailTemplateKey,
  ) {
    return this.templates.get(user.restaurantId, key);
  }

  @Auth('settings.emailTemplates')
  @Put(':key')
  update(
    @CurrentUser() user: SessionUser,
    @Param('key', TemplateKeyPipe) key: EmailTemplateKey,
    @Body(new ZodValidationPipe(emailTemplateUpdateSchema))
    body: EmailTemplateUpdateDto,
  ) {
    return this.templates.update(user.restaurantId, user.id, key, body);
  }

  @Auth('settings.emailTemplates')
  @Post(':key/reset')
  @HttpCode(200)
  reset(
    @CurrentUser() user: SessionUser,
    @Param('key', TemplateKeyPipe) key: EmailTemplateKey,
  ) {
    return this.templates.reset(user.restaurantId, key);
  }

  @Auth('settings.emailTemplates')
  @Post(':key/preview')
  @HttpCode(200)
  preview(
    @CurrentUser() user: SessionUser,
    @Param('key', TemplateKeyPipe) key: EmailTemplateKey,
    @Body(new ZodValidationPipe(emailTemplatePreviewSchema))
    body: EmailTemplatePreviewDto,
  ) {
    return this.templates.preview(user.restaurantId, key, body.draft);
  }

  // Per-IP throttle on top of the per-restaurant limit in the service.
  @Auth('settings.emailTemplates')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':key/test')
  @HttpCode(200)
  sendTest(
    @CurrentUser() user: SessionUser,
    @Param('key', TemplateKeyPipe) key: EmailTemplateKey,
    @Body(new ZodValidationPipe(emailTemplateTestSchema))
    body: EmailTemplateTestDto,
  ) {
    return this.templates.sendTest(user.restaurantId, key, body.to, body.draft);
  }
}
