import { RestoreVetError } from './pg-restore-vet';

export interface SequenceInfo {
  name: string;
  table: string;
  column: string;
  min: string;
  max: string;
}

export interface Setval {
  sequence: string;
  value: string;
  called: boolean;
}

export const qualified = (name: string) => `public."${name}"`;

/** Catalog identifiers become SQL/psql text, so accept the app's simple names only. */
export function simpleName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RestoreVetError('unsupported live schema identifier');
  }
  return name;
}

export function parseSequences(output: string): Map<string, SequenceInfo> {
  const out = new Map<string, SequenceInfo>();
  for (const row of output.trim().split('\n').filter(Boolean)) {
    const [name, table, column, min, max, increment, cycle, ...extra] =
      row.split('|');
    if (
      !table ||
      !column ||
      !/^\d+$/.test(min) ||
      !/^\d+$/.test(max) ||
      increment !== '1' ||
      cycle !== 'f' ||
      extra.length ||
      BigInt(min) > BigInt(max) ||
      out.has(name)
    ) {
      throw new RestoreVetError('unsupported live sequence metadata');
    }
    out.set(simpleName(name), {
      name,
      table: simpleName(table),
      column: simpleName(column),
      min,
      max,
    });
  }
  return out;
}

/** All archive values are checked before deletes or nontransactional setval. */
export function sequencePreflight(
  sequences: ReadonlyMap<string, SequenceInfo>,
  setvals: readonly Setval[],
): string[] {
  for (const s of setvals) {
    const meta = sequences.get(s.sequence);
    if (
      !meta ||
      !/^\d+$/.test(s.value) ||
      BigInt(s.value) < BigInt(meta.min) ||
      BigInt(s.value) > BigInt(meta.max)
    ) {
      throw new RestoreVetError('a sequence value is out of range');
    }
  }
  return [...sequences.values()].map(
    (s) => `DO $$ BEGIN
  IF NOT has_sequence_privilege(current_user, 'public."${s.name}"', 'SELECT')
     OR NOT has_sequence_privilege(current_user, 'public."${s.name}"', 'UPDATE') THEN
    RAISE EXCEPTION 'Restore refused: missing sequence privileges';
  END IF;
END $$;`,
  );
}

/**
 * PostgreSQL setval does not roll back. Never rewind: reconcile every live
 * counter to both its current state and the copied rows. Table locks exclude
 * normal app inserts; standalone administrative nextval requires maintenance.
 * Validate all targets before the first setval. A failure can leave forward
 * gaps, exactly as a failed INSERT can, but cannot rewind an existing counter.
 */
export function sequenceReconciliation(
  sequences: ReadonlyMap<string, SequenceInfo>,
  setvals: readonly Setval[],
): string[] {
  if (!sequences.size) return [];
  return [
    'SET CONSTRAINTS ALL IMMEDIATE;',
    'CREATE TEMP TABLE nventra_restore_counters (seq regclass, target bigint, called boolean) ON COMMIT DROP;',
    ...[...sequences.values()].map((s) => {
      const saved = setvals.find((v) => v.sequence === s.name);
      const archived = saved ? String(saved.value) : 'NULL::bigint';
      return `DO $$ DECLARE live bigint; was_called boolean; loaded bigint; target bigint; BEGIN
  SELECT last_value, is_called INTO live, was_called FROM ${qualified(s.name)};
  SELECT max("${s.column}") INTO loaded FROM ${qualified(s.table)};
  target := GREATEST(live, loaded, ${archived});
  IF target < ${s.min} OR target > ${s.max} THEN
    RAISE EXCEPTION 'Restore refused: sequence target out of range';
  END IF;
  INSERT INTO pg_temp.nventra_restore_counters VALUES ('public."${s.name}"', target,
    (target=live AND was_called) OR COALESCE(target=loaded,false) OR COALESCE(target=${archived} AND ${saved?.called ?? false},false));
END $$;`;
    }),
    'SELECT pg_catalog.setval(seq, target, called) FROM pg_temp.nventra_restore_counters;',
  ];
}
