import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { GraphqlRequest } from '@nventra/types';
import {
  execute,
  getOperationAST,
  GraphQLError,
  OperationTypeNode,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
} from 'graphql';
import {
  envLimit,
  hitIntegrationWrite,
} from '../common/guards/key-rate-limiter';
import type { GraphqlContext } from './graphql-context';
import {
  costLimitRule,
  depthLimitRule,
  mutationLimitRule,
  validationRules,
} from './graphql-limits';
import { BranchAccessService } from '../common/services/branch-access.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { MenuService } from '../modules/menu/menu.service';
import { PrismaService } from '../prisma/prisma.service';
import { createRootValue } from './graphql-resolvers';
import { schema } from './graphql.schema';

export type GraphqlResponse = {
  status: number;
  body: ExecutionResult;
  headers?: Record<string, string>;
};

@Injectable()
export class GraphqlService {
  private readonly logger = new Logger(GraphqlService.name);
  private readonly maxDepth = envLimit('GRAPHQL_MAX_DEPTH', 8);
  private readonly maxCost = envLimit('GRAPHQL_MAX_COST', 1000);
  private readonly maxTokens = envLimit('GRAPHQL_MAX_TOKENS', 5000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly integrations: IntegrationsService,
    private readonly menu: MenuService,
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
      mutationLimitRule(1),
    ]);
    if (limitErrors.length) return requestError(limitErrors);

    const limited = this.chargeWrite(document, req.operationName, ctx);
    if (limited) return limited;

    const result = await execute({
      schema,
      document,
      rootValue: createRootValue(
        {
          prisma: this.prisma,
          branchAccess: this.branchAccess,
          integrations: this.integrations,
          menu: this.menu,
        },
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

  // An integration key's mutation is a write: it spends the SAME per-key
  // budget as a REST write (INTEGRATION_WRITE_LIMIT_PER_MIN), on top of the
  // general GraphQL request limit, so switching transports never raises a
  // key's write rate. Staff sessions are not integration keys and are not
  // charged, as on REST.
  private chargeWrite(
    document: DocumentNode,
    operationName: string | null | undefined,
    ctx: GraphqlContext,
  ): GraphqlResponse | null {
    if (ctx.principal.kind !== 'integration') return null;
    const op = getOperationAST(document, operationName ?? undefined);
    if (op?.operation !== OperationTypeNode.MUTATION) return null;
    const retryAfter = hitIntegrationWrite(ctx.principal.id);
    if (retryAfter === 0) return null;
    return {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
      body: {
        errors: [
          new GraphQLError(
            'Too many writes for this API key — slow down and retry later',
            { extensions: { code: 'RATE_LIMITED', retryAfter } },
          ),
        ],
      },
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
  if (status === 409) return 'CONFLICT';
  // Business-rule rejections from the REST services (an unavailable dish,
  // below the minimum order, an Idempotency-Key reused with another body).
  if (status === 400 || status === 422) return 'BAD_USER_INPUT';
  return status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR';
}
