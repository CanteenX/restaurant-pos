import { Module } from '@nestjs/common';
import { BranchAccessService } from '../common/services/branch-access.service';
import { GraphqlAuthGuard } from './graphql-auth.guard';
import { GraphqlController } from './graphql.controller';
import { GraphqlService } from './graphql.service';

@Module({
  controllers: [GraphqlController],
  providers: [GraphqlService, GraphqlAuthGuard, BranchAccessService],
})
export class GraphqlModule {}
