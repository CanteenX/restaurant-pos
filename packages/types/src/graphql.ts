import { z } from "zod";

// POST /api/v1/graphql body. Sizes are bounded here so an oversized document
// is refused before the GraphQL parser ever sees it.
export const GRAPHQL_MAX_QUERY_LENGTH = 50_000;

export const graphqlRequestSchema = z.object({
  query: z.string().min(1).max(GRAPHQL_MAX_QUERY_LENGTH),
  operationName: z.string().max(200).nullish(),
  variables: z.record(z.string(), z.unknown()).nullish(),
});
export type GraphqlRequest = z.infer<typeof graphqlRequestSchema>;
