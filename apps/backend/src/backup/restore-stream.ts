import { spawn } from 'node:child_process';
import { Transform, TransformCallback } from 'node:stream';
import { pgEnvFromUrl, knownDbSecrets, redactSecrets } from './pg-env';
import { RestoreVetError } from './pg-restore-vet';

const MAX_STDERR = 4096;

const SET_LINE = /^SET [a-z_.]+ = ('[^']*'|[a-z0-9_.-]+);$/i;
// Newer pg_restore versions wrap scripts in \restrict/\unrestrict, which make
// psql refuse every other meta-command. Allowed only in this exact form.
const RESTRICT_LINE = /^\\(un)?restrict [A-Za-z0-9]+$/;
const SEARCH_PATH = "SELECT pg_catalog.set_config('search_path', '', false);";
const COPY_LINE =
  /^COPY public\.("?)([A-Za-z0-9_]+)\1 \(([A-Za-z0-9_", ]+)\) FROM stdin;$/;
const SETVAL_LINE =
  /^SELECT pg_catalog\.setval\('public\."?([A-Za-z0-9_]+)"?', \d+, (true|false)\);$/;

/**
 * Streams a `pg_restore --data-only -f -` script and refuses anything that is
 * not a plain data load. The script is fed to psql, which would also run
 * backslash meta-commands (`\!` runs a shell command), so a tampered archive
 * entry must never reach it. Outside COPY blocks only SET lines, the
 * search_path call, `COPY public.<app table> (...) FROM stdin;` and setval on
 * an app table's sequence are allowed; COPY data lines are opaque data.
 */
export class ScriptGuard extends Transform {
  private pending = '';
  private inCopy = false;

  constructor(
    private readonly tables: ReadonlySet<string>,
    private readonly onViolation: () => void,
  ) {
    super({ decodeStrings: false });
  }

  private violation(what: string, line = ''): RestoreVetError {
    this.onViolation();
    const shown = [...line.slice(0, 60)]
      .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e ? '?' : c))
      .join('');
    return new RestoreVetError(
      `the restore script contained ${what}${shown ? ` ("${shown}")` : ''}`,
    );
  }

  /** Validates a line; returns false when the line must be dropped. */
  private check(line: string): boolean {
    if (this.inCopy) {
      if (line === '\\.') this.inCopy = false;
      return true;
    }
    // Dropped: the script is fully schema-qualified, and an empty search_path
    // would break the app's own triggers (e.g. sync) that fire during the load.
    if (line === SEARCH_PATH) return false;
    if (line === '' || line.startsWith('--')) return true;
    if (SET_LINE.test(line) || RESTRICT_LINE.test(line)) return true;
    const copy = COPY_LINE.exec(line);
    if (copy && this.tables.has(copy[2])) {
      this.inCopy = true;
      return true;
    }
    const seq = SETVAL_LINE.exec(line);
    if (seq && [...this.tables].some((t) => seq[1].startsWith(`${t}_`))) {
      return true;
    }
    throw this.violation('an unexpected statement', line);
  }

  _transform(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: TransformCallback,
  ) {
    try {
      this.pending += chunk.toString();
      const lines = this.pending.split('\n');
      this.pending = lines.pop() ?? '';
      const kept = lines.filter((l) => this.check(l));
      cb(null, kept.length ? `${kept.join('\n')}\n` : '');
    } catch (err) {
      cb(err as Error);
    }
  }

  _flush(cb: TransformCallback) {
    try {
      const keep = this.pending !== '' && this.check(this.pending);
      if (this.inCopy) throw this.violation('an unterminated COPY block');
      cb(null, keep ? this.pending : '');
    } catch (err) {
      cb(err as Error);
    }
  }
}

export interface StreamedRestoreOptions {
  file: string;
  listFile: string;
  url: string | undefined;
  /** SQL run first, in the same transaction (session settings, deletes). */
  prelude: string;
  tables: ReadonlySet<string>;
}

function capture(stream: NodeJS.ReadableStream | null): () => string {
  let buf = '';
  stream?.on('data', (d: Buffer) => {
    if (buf.length < MAX_STDERR) buf += d.toString();
  });
  return () => buf.trim();
}

/**
 * pg_restore (script mode) -> ScriptGuard -> psql --single-transaction.
 * psql is only allowed to reach COMMIT when pg_restore exited cleanly AND the
 * whole script passed the guard; every other outcome kills psql first, so
 * the transaction (prelude deletes included) rolls back and the original
 * data stays intact.
 */
export function runStreamedRestore(o: StreamedRestoreOptions): Promise<void> {
  const env = { ...process.env, ...pgEnvFromUrl(o.url) };
  const secrets = knownDbSecrets(o.url);
  const restore = spawn(
    'pg_restore',
    [
      '--data-only',
      '--no-owner',
      '--no-privileges',
      '-L',
      o.listFile,
      '-f',
      '-',
      o.file,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const psql = spawn(
    'psql',
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const restoreErr = capture(restore.stderr);
  const psqlErr = capture(psql.stderr);
  psql.stdout?.resume();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let guardEnded = false;
    let restoreExit: number | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      psql.kill('SIGKILL');
      restore.kill('SIGKILL');
      reject(err);
    };
    const maybeCommit = () => {
      if (settled || !guardEnded || restoreExit === null) return;
      if (restoreExit !== 0) {
        fail(
          new Error(
            redactSecrets(`pg_restore failed: ${restoreErr()}`, secrets),
          ),
        );
        return;
      }
      psql.stdin?.end(); // EOF is what makes psql COMMIT
    };

    const guard = new ScriptGuard(o.tables, () => psql.kill('SIGKILL'));
    guard.on('error', (e) => fail(e));
    guard.on('end', () => {
      guardEnded = true;
      maybeCommit();
    });
    restore.on('close', (code: number | null) => {
      restoreExit = code ?? 1;
      maybeCommit();
    });
    psql.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      if (code === 0) return resolve();
      restore.kill('SIGKILL');
      reject(new Error(redactSecrets(`psql failed: ${psqlErr()}`, secrets)));
    });

    psql.stdin?.write(o.prelude);
    restore.stdout?.pipe(guard).pipe(psql.stdin, { end: false });
  });
}
