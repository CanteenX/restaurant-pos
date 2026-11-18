import { z } from "zod";
import {
  createIntegrationOrderSchema,
  integrationIdempotencyKeySchema,
} from "./integrations";

// POST /api/v1/graphql body. Sizes are bounded here so an oversized document
// is refused before the GraphQL parser ever sees it.
export const GRAPHQL_MAX_QUERY_LENGTH = 50_000;

export const graphqlRequestSchema = z.object({
  query: z.string().min(1).max(GRAPHQL_MAX_QUERY_LENGTH),
  operationName: z.string().max(200).nullish(),
  variables: z.record(z.string(), z.unknown()).nullish(),
});
export type GraphqlRequest = z.infer<typeof graphqlRequestSchema>;

// Mutation arguments (#79), parsed at the resolver boundary after GraphQL's
// own type checks. The order body IS the REST Integration API schema, so a
// GraphQL order is validated, priced and de-duplicated exactly like a REST
// one. GraphQL sends explicit nulls for omitted optionals; the resolver
// drops them before parsing.
export const graphqlCreateOrderArgsSchema = z.object({
  branchId: z.string().trim().min(1).max(64),
  idempotencyKey: integrationIdempotencyKeySchema.optional(),
  input: createIntegrationOrderSchema,
});
export type GraphqlCreateOrderArgs = z.infer<typeof graphqlCreateOrderArgsSchema>;

export const graphqlSetMenuItemAvailabilityArgsSchema = z.object({
  id: z.string().trim().min(1).max(64),
  available: z.boolean(),
});
export type GraphqlSetMenuItemAvailabilityArgs = z.infer<
  typeof graphqlSetMenuItemAvailabilityArgsSchema
>;
