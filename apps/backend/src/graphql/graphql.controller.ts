import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { graphqlRequestSchema, type GraphqlRequest } from '@nventra/types';
import type { SessionUser } from '@nventra/types';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { GraphqlAuthGuard } from './graphql-auth.guard';
import { buildGraphqlContext } from './graphql-context';
import { GraphqlService } from './graphql.service';

// POST /api/v1/graphql — see docs/graphql-api.md.
@Controller('v1/graphql')
export class GraphqlController {
  constructor(private readonly graphql: GraphqlService) {}

  @Post()
  @UseGuards(GraphqlAuthGuard)
  @UsePipes(new ZodValidationPipe(graphqlRequestSchema))
  async query(
    @Body() body: GraphqlRequest,
    @Req() req: Request & { user?: SessionUser },
    @Res() res: Response,
  ) {
    const {
      status,
      body: result,
      headers,
    } = await this.graphql.run(body, buildGraphqlContext(req));
    for (const [name, value] of Object.entries(headers ?? {})) {
      res.setHeader(name, value);
    }
    res.status(status).json(result);
  }

  // No GET queries: they would be cacheable and cross-site triggerable.
  @Get()
  @HttpCode(405)
  methodNotAllowed(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Allow', 'POST');
    return { message: 'Use POST with an application/json body' };
  }
}
