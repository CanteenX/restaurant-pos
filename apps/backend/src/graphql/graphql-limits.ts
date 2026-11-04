import {
  getArgumentValues,
  getNamedType,
  getVariableValues,
  GraphQLError,
  isInterfaceType,
  isObjectType,
  Kind,
  NoSchemaIntrospectionCustomRule,
  specifiedRules,
  type ASTVisitor,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
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
  return operationRule((sel, fragments, context, operation) => {
    const schema = context.getSchema();
    const root = schema.getRootType(operation.operation);
    if (!root) return null;
    // Coerced exactly as execute() will: supplied values, else the
    // operation's own defaults. Bad input fails execution anyway.
    const coerced = getVariableValues(
      schema,
      operation.variableDefinitions ?? [],
      variables,
    );
    const vars = coerced.coerced ?? {};
    const memo = new Map<string, number>();
    const cost = (
      set: SelectionSetNode,
      parent: GraphQLNamedType,
      seen: Set<string>,
    ): number => {
      let total = 0;
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) {
          if (s.name.value === '__typename') continue;
          const def = fieldDef(parent, s.name.value);
          const below =
            s.selectionSet && def
              ? cost(s.selectionSet, getNamedType(def.type), seen)
              : 0;
          // A paged field is charged at least one per row it asks for, so a
          // free sub-selection (`__typename`) or a leaf list cannot hide it.
          total +=
            def && isPaged(def)
              ? 1 + pageSize(def, s, vars) * Math.max(1, below)
              : 1 + below;
        } else if (s.kind === Kind.INLINE_FRAGMENT) {
          total += cost(s.selectionSet, narrow(schema, s, parent), seen);
        } else {
          const frag = fragments.get(s.name.value);
          const type = frag ? narrow(schema, frag, parent) : parent;
          total += viaFragment(s.name.value, fragments, memo, seen, (fs, sn) =>
            cost(fs, type, sn),
          );
        }
      }
      return total;
    };
    const c = cost(sel, root, new Set());
    return c > maxCost
      ? `Query cost ${c} exceeds the maximum of ${maxCost}`
      : null;
  });
}

function fieldDef(
  parent: GraphQLNamedType,
  name: string,
): GraphQLField<unknown, unknown> | undefined {
  return isObjectType(parent) || isInterfaceType(parent)
    ? parent.getFields()[name]
    : undefined;
}

function narrow(
  schema: GraphQLSchema,
  node: InlineFragmentNode | FragmentDefinitionNode,
  parent: GraphQLNamedType,
): GraphQLNamedType {
  return node.typeCondition
    ? (schema.getType(node.typeCondition.name.value) ?? parent)
    : parent;
}

const PAGE_ARGS = ['first', 'last', 'limit', 'take'];

function isPaged(def: GraphQLField<unknown, unknown>): boolean {
  return def.args.some((a) => PAGE_ARGS.includes(a.name));
}

// Uses the argument values the resolver will actually receive: literal,
// variable (or its default) and, when omitted, the schema's default. An
// explicit null is charged like an omitted argument (the schema default),
// matching clampPage() in the resolvers.
function pageSize(
  def: GraphQLField<unknown, unknown>,
  node: FieldNode,
  vars: Record<string, unknown>,
): number {
  let args: Record<string, unknown>;
  try {
    args = getArgumentValues(def, node, vars);
  } catch {
    return 1; // invalid arguments: execute() rejects the field anyway
  }
  for (const name of PAGE_ARGS) {
    const argDef = def.args.find((a) => a.name === name);
    if (!argDef) continue;
    const value = args[name] ?? argDef.defaultValue;
    const v = Number(value);
    if (value != null && Number.isFinite(v)) {
      return v > 1 ? Math.ceil(v) : 1;
    }
  }
  return 1;
}

export interface PageLimits {
  /** Page size used when the argument is omitted or null. */
  defaultSize: number;
  /** Server-side maximum; larger requests are cut to this. */
  max: number;
}

/**
 * The page size a list resolver must use: omitted or null means the
 * default (never "no limit"), and every value is clamped to [1, max].
 */
export function clampPage(
  value: number | null | undefined,
  limits: PageLimits,
): number {
  const raw = value ?? limits.defaultSize;
  const n = Number.isFinite(raw) ? Math.floor(raw) : limits.defaultSize;
  return Math.min(limits.max, Math.max(1, n));
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

function operationRule(
  check: (
    set: SelectionSetNode,
    fragments: Fragments,
    context: ValidationContext,
    operation: OperationDefinitionNode,
  ) => string | null,
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
        const message = check(node.selectionSet, fragments, context, node);
        if (message)
          context.reportError(new GraphQLError(message, { nodes: [node] }));
        return false;
      },
    };
  };
}
