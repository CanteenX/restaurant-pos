import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UsePipes,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  integrationItemMapPatchSchema,
  type IntegrationItemMapPatchDto,
  type SessionUser,
} from '@nventra/types';
import { z } from 'zod';
import { AuditAction } from '../audit/audit-action';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { IntegrationHubService } from './integration-hub.service';

const connectSchema = z.object({
  externalAccountId: z.string().trim().max(120).optional(),
  credentials: z.record(z.string().max(60), z.string().max(500)).default({}),
  outlets: z
    .record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(60))
    .refine((o) => Object.keys(o).length <= 200, 'At most 200 outlets')
    .optional(),
  itemMap: z
    .record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(120))
    .refine((o) => Object.keys(o).length <= 2000, 'At most 2000 items')
    .optional(),
});
const menuSyncSchema = z.object({ branchId: z.string().trim().min(1).max(60) });
const enabledSchema = z.object({ enabled: z.boolean() });

// Managing outside connections is an owner/admin job: settings.manage. The
// restaurant always comes from the session, never from the request.
@ApiTags('integration-hub')
@Controller('v1/integration-hub')
export class IntegrationHubController {
  constructor(private readonly hub: IntegrationHubService) {}

  @Auth('settings.manage')
  @Get()
  list(@CurrentUser() u: SessionUser) {
    return this.hub.list(u.restaurantId);
  }

  @Auth('settings.manage')
  @AuditAction('integration.saved', 'IntegrationConnection')
  @Put(':provider')
  @UsePipes(new ZodValidationPipe(connectSchema))
  connect(
    @CurrentUser() u: SessionUser,
    @Param('provider') provider: string,
    @Body() body: z.infer<typeof connectSchema>,
  ) {
    return this.hub.connect(u.restaurantId, u.id, provider, body);
  }

  @Auth('settings.manage')
  @AuditAction('integration.tested', 'IntegrationConnection')
  @Post(':provider/test')
  test(@CurrentUser() u: SessionUser, @Param('provider') provider: string) {
    return this.hub.test(u.restaurantId, provider);
  }

  @Auth('settings.manage')
  @AuditAction('integration.toggled', 'IntegrationConnection')
  @Post(':provider/enabled')
  setEnabled(
    @CurrentUser() u: SessionUser,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(enabledSchema))
    body: z.infer<typeof enabledSchema>,
  ) {
    return this.hub.setEnabled(u.restaurantId, provider, body.enabled);
  }

  // A patch, merged server-side: never replaces mappings it does not name.
  @Auth('settings.manage')
  @AuditAction('integration.item_map_saved', 'IntegrationConnection')
  @Patch(':provider/item-map')
  patchItemMap(
    @CurrentUser() u: SessionUser,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(integrationItemMapPatchSchema))
    body: IntegrationItemMapPatchDto,
  ) {
    return this.hub.patchItemMap(u.restaurantId, provider, body);
  }

  @Auth('settings.manage')
  @AuditAction('integration.retried', 'IntegrationConnection')
  @Post(':provider/outbox/retry')
  retry(@CurrentUser() u: SessionUser, @Param('provider') provider: string) {
    return this.hub.retryFailed(u.restaurantId, provider);
  }

  @Auth('settings.manage')
  @AuditAction('integration.menu_synced', 'IntegrationConnection')
  @Post(':provider/menu-sync')
  menuSync(
    @CurrentUser() u: SessionUser,
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(menuSyncSchema))
    body: z.infer<typeof menuSyncSchema>,
  ) {
    return this.hub.syncMenu(u.restaurantId, provider, body.branchId);
  }

  @Auth('settings.manage')
  @Get(':provider/logs')
  logs(@CurrentUser() u: SessionUser, @Param('provider') provider: string) {
    return this.hub.logs(u.restaurantId, provider);
  }

  @Auth('settings.manage')
  @AuditAction('integration.disconnected', 'IntegrationConnection')
  @Delete(':provider')
  disconnect(
    @CurrentUser() u: SessionUser,
    @Param('provider') provider: string,
  ) {
    return this.hub.disconnect(u.restaurantId, provider);
  }
}
