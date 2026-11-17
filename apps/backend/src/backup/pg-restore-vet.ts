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
): string[] {
  const lines = toc.split('\n').map((l) => l.trim());
  if (!lines.some((l) => /^\d+;/.test(l))) {
    throw new RestoreVetError('it is empty or unreadable');
  }
  const allowed: string[] = [];
  for (const line of lines) {
    const m = DATA_LINE.exec(line);
    if (!m) continue; // schema, functions, triggers, ACLs...: never executed
    const [, , kind, schema, name] = m;
    if (IGNORED_TABLES.has(name)) continue;
    const known =
      kind === 'TABLE DATA'
        ? appTables.has(name)
        : [...appTables].some((t) => name.startsWith(`${t}_`));
    if (schema !== 'public' || !known) {
      throw new RestoreVetError(
        `it contains data for "${shown(`${schema}.${name}`)}", which is not an app table`,
      );
    }
    allowed.push(line);
  }
  if (!allowed.some((l) => DATA_LINE.exec(l)?.[2] === 'TABLE DATA')) {
    throw new RestoreVetError('it contains no table data to restore');
  }
  return allowed;
}
