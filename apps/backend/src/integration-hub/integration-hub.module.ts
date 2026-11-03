import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BranchAccessService } from '../common/services/branch-access.service';
import { OrdersModule } from '../modules/orders/orders.module';
import { AggregatorOrdersService } from './aggregator-orders.service';
import { IntegrationHubWebhookController } from './integration-hub.webhook.controller';
import { IntegrationHubController } from './integration-hub.controller';
import { IntegrationHubService } from './integration-hub.service';
import {
  PaymentGatewayController,
  PaymentGatewayWebhookController,
} from './payments/payment-gateway.controller';
import { PaymentGatewayService } from './payments/payment-gateway.service';

@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [
    IntegrationHubController,
    IntegrationHubWebhookController,
    PaymentGatewayController,
    PaymentGatewayWebhookController,
  ],
  providers: [
    IntegrationHubService,
    AggregatorOrdersService,
    PaymentGatewayService,
    BranchAccessService,
  ],
  exports: [IntegrationHubService, PaymentGatewayService],
})
export class IntegrationHubModule {}
