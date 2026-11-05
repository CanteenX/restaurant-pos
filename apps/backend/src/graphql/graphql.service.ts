import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { GraphqlRequest } from '@nventra/types';
import {
  execute,
  GraphQLError,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
} from 'graphql';
import { envLimit } from '../common/guards/key-rate-limiter';
import type { GraphqlContext } from './graphql-context';
import {
  costLimitRule,
  depthLimitRule,
  validationRules,
} from './graphql-limits';
import { BranchAccessService } from '../common/services/branch-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { createRootValue } from './graphql-resolvers';
import { schema } from './graphql.schema';

export type GraphqlResponse = { status: number; body: ExecutionResult };

@Injectable()
export class GraphqlService {
  private readonly logger = new Logger(GraphqlService.name);
  private readonly maxDepth = envLimit('GRAPHQL_MAX_DEPTH', 8);
  private readonly maxCost = envLimit('GRAPHQL_MAX_COST', 1000);
  private readonly maxTokens = envLimit('GRAPHQL_MAX_TOKENS', 5000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  async run(
    req: GraphqlRequest,
    ctx: GraphqlContext,
  ): Promise<GraphqlResponse> {
    let document: DocumentNode;
    try {
      document = parse(req.query, { maxTokens: this.maxTokens });
    } catch (e) {
      return requestError(e instanceof GraphQLError ? [e] : [syntaxError()]);
    }

    const variables = req.variables ?? {};
    const production = process.env.NODE_ENV === 'production';
    // Spec rules first: the shape limits assume a valid document.
    const specErrors = validate(
      schema,
      document,
      validationRules({ production }),
    );
    if (specErrors.length) return requestError(specErrors);
    const limitErrors = validate(schema, document, [
      depthLimitRule(this.maxDepth),
      costLimitRule(this.maxCost, variables),
    ]);
    if (limitErrors.length) return requestError(limitErrors);

    const result = await execute({
      schema,
      document,
      rootValue: createRootValue(
        { prisma: this.prisma, branchAccess: this.branchAccess },
        ctx,
      ),
      contextValue: ctx,
      variableValues: variables,
      operationName: req.operationName ?? undefined,
    });
    return {
      status: 200,
      body: result.errors
        ? { ...result, errors: result.errors.map((e) => this.mask(e)) }
        : result,
    };
  }

  // Resolver errors reach the client only when they are deliberate: a
  // GraphQLError, or an HttpException (Forbidden, NotFound, …). Anything
  // else (Prisma, bugs) is logged and replaced, so internals never leak.
  private mask(error: GraphQLError): GraphQLError {
    const original = error.originalError;
    if (!original || original instanceof GraphQLError) return error;
    if (original instanceof HttpException) {
      return new GraphQLError(original.message, {
        nodes: error.nodes,
        path: error.path,
        extensions: { code: httpCode(original.getStatus()) },
      });
    }
    this.logger.error(original.stack ?? original.message);
    return new GraphQLError('Internal server error', {
      nodes: error.nodes,
      path: error.path,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  }
}

function requestError(errors: readonly GraphQLError[]): GraphqlResponse {
  return { status: 400, body: { errors: [...errors] } };
}

function syntaxError() {
  return new GraphQLError('Could not parse the GraphQL document');
}

function httpCode(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  return status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR';
}
