import { Module } from '@nestjs/common';
import { BranchAccessService } from '../common/services/branch-access.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MenuModule } from '../modules/menu/menu.module';
import { GraphqlAuthGuard } from './graphql-auth.guard';
import { GraphqlController } from './graphql.controller';
import { GraphqlService } from './graphql.service';

@Module({
  // Mutations write through the REST services (#79), never around them.
  imports: [IntegrationsModule, MenuModule],
  controllers: [GraphqlController],
  providers: [GraphqlService, GraphqlAuthGuard, BranchAccessService],
})
export class GraphqlModule {}
