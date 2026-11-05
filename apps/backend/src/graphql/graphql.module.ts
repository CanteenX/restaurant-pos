import { Module } from '@nestjs/common';
import { GraphqlAuthGuard } from './graphql-auth.guard';
import { GraphqlController } from './graphql.controller';
import { GraphqlService } from './graphql.service';

@Module({
  controllers: [GraphqlController],
  providers: [GraphqlService, GraphqlAuthGuard],
})
export class GraphqlModule {}
