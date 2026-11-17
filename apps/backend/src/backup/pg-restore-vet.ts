/**
 * Data-only restore allow-list. The dump's schema, functions, triggers,
 * roles, extensions, ACLs and comments are NEVER executed: only `TABLE DATA`
 * entries for known app tables and `SEQUENCE SET` entries for their
 * sequences are put in the `pg_restore -L` list. Labels in a TOC cannot be
 * trusted on their own, so this is combined with a non-superuser restore
 * role (which cannot `COPY ... PROGRAM` even if a COPY statement is
 * tampered with) and `--data-only`.
 */

/** Present in the live DB but never restored from a backup. */
const IGNORED_TABLES = new Set(['_prisma_migrations']);
const DATA_LINE =
  /^(\d+;\s+\d+\s+\d+)\s+(TABLE DATA|SEQUENCE SET)\s+(\S+)\s+(\S+)/;

export interface DataEntry {
  kind: 'TABLE DATA' | 'SEQUENCE SET';
  schema: string;
  name: string;
}

/** Parses a TOC line that selectDataEntries already allowed. */
export function parseDataEntry(line: string): DataEntry | null {
  const m = DATA_LINE.exec(line);
  return m
    ? { kind: m[2] as DataEntry['kind'], schema: m[3], name: m[4] }
    : null;
}

export class RestoreVetError extends Error {
  constructor(reason: string) {
    super(`Backup database dump rejected: ${reason}`);
    this.name = 'RestoreVetError';
  }
}

function shown(raw: string): string {
  const clean = [...raw]
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e ? '?' : c))
    .join('');
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

/**
 * Returns the TOC lines that may be restored. Throws on an empty TOC, on
 * data for a table that is not an app table, and when nothing restorable
 * is found.
 */
export function selectDataEntries(
  toc: string,
  appTables: ReadonlySet<string>,
  appSequences: ReadonlySet<string> = new Set(),
): string[] {
  const lines = toc.split('\n').map((l) => l.trim());
  if (!lines.some((l) => /^\d+;/.test(l))) {
    throw new RestoreVetError('it is empty or unreadable');
  }
  const allowed: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m = DATA_LINE.exec(line);
    if (!m) continue; // schema, functions, triggers, ACLs...: never executed
    const [, , kind, schema, name] = m;
    if (IGNORED_TABLES.has(name)) continue;
    const known =
      kind === 'TABLE DATA' ? appTables.has(name) : appSequences.has(name);
    if (schema !== 'public' || !known) {
      throw new RestoreVetError(
        `it contains data for "${shown(`${schema}.${name}`)}", which is not an app table`,
      );
    }
    const key = `${kind}:${name}`;
    if (seen.has(key)) throw new RestoreVetError('duplicate data entry');
    seen.add(key);
    allowed.push(line);
  }
  if (!allowed.some((l) => DATA_LINE.exec(l)?.[2] === 'TABLE DATA')) {
    throw new RestoreVetError('it contains no table data to restore');
  }
  return allowed;
}

/**
 * Orders allowed entries so parent tables load before the tables that
 * reference them (pg_restore honours the order of a `-L` list). Sequence
 * values go last. `loadOrder` is parents-first.
 */
export function orderEntries(
  entries: readonly string[],
  loadOrder: readonly string[],
): string[] {
  const rank = (line: string): number => {
    const m = DATA_LINE.exec(line);
    if (!m || m[2] !== 'TABLE DATA') return Number.MAX_SAFE_INTEGER;
    const i = loadOrder.indexOf(m[4]);
    return i === -1 ? loadOrder.length : i;
  };
  return entries
    .map((line, idx) => ({ line, idx, r: rank(line) }))
    .sort((a, b) => a.r - b.r || a.idx - b.idx)
    .map((e) => e.line);
}
