import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { IntegrationOutboxService } from './integration-outbox.service';

// Global so OrdersService and DeliveryService can queue platform status
// updates without importing IntegrationHubModule (which imports OrdersModule).
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [IntegrationOutboxService],
  exports: [IntegrationOutboxService],
})
export class IntegrationOutboxModule {}
