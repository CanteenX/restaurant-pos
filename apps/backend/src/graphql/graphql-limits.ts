import {
  GraphQLError,
  Kind,
  NoSchemaIntrospectionCustomRule,
  specifiedRules,
  type ASTVisitor,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
  type ValueNode,
} from 'graphql';

// Query-shape limits for the public GraphQL endpoint. Both walk the
// operation through fragment spreads with a per-fragment memo, so a document
// that spreads fragments exponentially is still measured in linear time, and
// a fragment cycle (reported by the spec's NoFragmentCyclesRule) is cut
// rather than looping. Aliases are charged per occurrence, so alias bombs
// cost what they really cost to resolve.

type Fragments = Map<string, FragmentDefinitionNode>;

/** The spec rules plus "no introspection" in production. */
export function validationRules(opts: {
  production: boolean;
}): ValidationRule[] {
  return opts.production
    ? [...specifiedRules, NoSchemaIntrospectionCustomRule]
    : [...specifiedRules];
}

export function depthLimitRule(maxDepth: number): ValidationRule {
  return operationRule((sel, fragments) => {
    const memo = new Map<string, number>();
    const depth = (set: SelectionSetNode, seen: Set<string>): number => {
      let max = 0;
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) {
          if (s.name.value === '__typename') continue;
          const below = s.selectionSet ? depth(s.selectionSet, seen) : 0;
          max = Math.max(max, 1 + below);
        } else if (s.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, depth(s.selectionSet, seen));
        } else {
          max = Math.max(
            max,
            viaFragment(s.name.value, fragments, memo, seen, depth),
          );
        }
      }
      return max;
    };
    const d = depth(sel, new Set());
    return d > maxDepth
      ? `Query depth ${d} exceeds the maximum of ${maxDepth}`
      : null;
  });
}

export function costLimitRule(
  maxCost: number,
  variables: Record<string, unknown> = {},
): ValidationRule {
  return operationRule((sel, fragments) => {
    const memo = new Map<string, number>();
    const cost = (set: SelectionSetNode, seen: Set<string>): number => {
      let total = 0;
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) {
          if (s.name.value === '__typename') continue;
          const page = pageSize(s.arguments ?? [], variables);
          total += 1 + (s.selectionSet ? page * cost(s.selectionSet, seen) : 0);
        } else if (s.kind === Kind.INLINE_FRAGMENT) {
          total += cost(s.selectionSet, seen);
        } else {
          total += viaFragment(s.name.value, fragments, memo, seen, cost);
        }
      }
      return total;
    };
    const c = cost(sel, new Set());
    return c > maxCost
      ? `Query cost ${c} exceeds the maximum of ${maxCost}`
      : null;
  });
}

function viaFragment(
  name: string,
  fragments: Fragments,
  memo: Map<string, number>,
  seen: Set<string>,
  measure: (set: SelectionSetNode, seen: Set<string>) => number,
): number {
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  const frag = fragments.get(name);
  if (!frag || seen.has(name)) return 0;
  seen.add(name);
  const value = measure(frag.selectionSet, seen);
  seen.delete(name);
  memo.set(name, value);
  return value;
}

const PAGE_ARGS = new Set(['first', 'last', 'limit', 'take']);

function pageSize(
  args: readonly { name: { value: string }; value: ValueNode }[],
  variables: Record<string, unknown>,
): number {
  for (const a of args) {
    if (!PAGE_ARGS.has(a.name.value)) continue;
    const v =
      a.value.kind === Kind.INT
        ? Number(a.value.value)
        : a.value.kind === Kind.VARIABLE
          ? Number(variables[a.value.name.value])
          : NaN;
    return Number.isFinite(v) && v > 1 ? Math.ceil(v) : 1;
  }
  return 1;
}

function operationRule(
  check: (set: SelectionSetNode, fragments: Fragments) => string | null,
): ValidationRule {
  return (context: ValidationContext): ASTVisitor => {
    const fragments: Fragments = new Map();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def);
      }
    }
    return {
      OperationDefinition(node) {
        const message = check(node.selectionSet, fragments);
        if (message)
          context.reportError(new GraphQLError(message, { nodes: [node] }));
        return false;
      },
    };
  };
}
