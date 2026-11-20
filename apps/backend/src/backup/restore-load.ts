import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { knownDbSecrets, pgEnvFromUrl, redactSecrets } from './pg-env';
import { parseDataEntry, RestoreVetError } from './pg-restore-vet';
import { runPg } from './pg-run';
import {
  qualified,
  SequenceInfo,
  sequencePreflight,
  sequenceReconciliation,
  Setval,
} from './restore-sequences';

/*
 * psql never interprets text taken from a dump. For every allowed table we
 * pull ONLY the raw COPY data rows out of `pg_restore -f -` output into a
 * file, and generate the psql script ourselves: identifiers come from the
 * live schema, numbers are validated, and the data is loaded with
 * `\copy ... FROM '<file>'`, where psql treats the file purely as COPY data.
 * Everything runs in one `psql --single-transaction`.
 */

const COPY_HEADER =
  /^COPY public\.("?)([A-Za-z0-9_]+)\1 \(([A-Za-z0-9_", ]+)\) FROM stdin;$/;
const SETVAL =
  /^SELECT pg_catalog\.setval\('public\."?([A-Za-z0-9_]+)"?', (\d+), (true|false)\);$/;
const SAFE_PATH = /^[A-Za-z0-9_.:/ -]+$/;
const LF = 0x0a;
const END_MARKER = Buffer.from('\\.');
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

export interface RestoreLimits {
  lineBytes: number;
  outputBytes: number;
}

function configuredBytes(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new RestoreVetError(
      `${name} must be a positive safe integer in bytes`,
    );
  }
  return value;
}

/** Compressed size is a sizing hint, never proof of the decompressed size. */
export function restoreLimits(
  archiveBytes: number,
  env = process.env,
): RestoreLimits {
  const archiveMax = configuredBytes(
    env,
    'NVENTRA_RESTORE_MAX_ARCHIVE_BYTES',
    4 * 1024 ** 3,
  );
  if (
    !Number.isSafeInteger(archiveBytes) ||
    archiveBytes < 0 ||
    archiveBytes > archiveMax
  ) {
    throw new RestoreVetError(
      `compressed archive exceeds NVENTRA_RESTORE_MAX_ARCHIVE_BYTES (${archiveMax} bytes)`,
    );
  }
  const outputBytes = configuredBytes(
    env,
    'NVENTRA_RESTORE_MAX_OUTPUT_BYTES',
    Math.max(MAX_OUTPUT_BYTES, Math.min(16 * 1024 ** 3, archiveBytes * 128)),
  );
  const lineBytes = configuredBytes(
    env,
    'NVENTRA_RESTORE_MAX_LINE_BYTES',
    Math.min(64 * 1024 ** 2, outputBytes),
  );
  return { lineBytes, outputBytes };
}

function sizeError(name: string, limit: number): RestoreVetError {
  return new RestoreVetError(
    `data exceeds size limit: ${name} (${limit} bytes); increase this setting only for a trusted, expected backup`,
  );
}

const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * Byte-level (never decodes row data) extractor: finds the table's COPY
 * header, validates its table and columns against the live schema, then
 * passes the data rows through until the first line that is exactly `\.`.
 */
export class CopyDataExtractor extends Transform {
  columns: string[] = [];
  private rest: Buffer = Buffer.alloc(0);
  private state: 'seek' | 'data' | 'done' = 'seek';
  private bytes = 0;

  get outputBytes(): number {
    return this.bytes;
  }

  constructor(
    private readonly table: string,
    private readonly liveColumns: ReadonlySet<string>,
    private readonly limits: RestoreLimits = {
      lineBytes: MAX_LINE_BYTES,
      outputBytes: MAX_OUTPUT_BYTES,
    },
  ) {
    super();
  }

  private header(line: string): void {
    const m = COPY_HEADER.exec(line);
    if (!m) return; // SET lines, comments, \restrict: never used, never run
    if (m[2] !== this.table) {
      throw new RestoreVetError('a data section is for an unexpected table');
    }
    const cols = m[3].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (
      new Set(cols).size !== cols.length ||
      cols.some((c) => !this.liveColumns.has(c))
    ) {
      throw new RestoreVetError(
        'a data section has unknown or repeated columns',
      );
    }
    this.columns = cols;
    this.state = 'data';
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      let buf = Buffer.concat([this.rest, chunk]);
      this.bytes += chunk.length;
      if (this.bytes > this.limits.outputBytes)
        throw sizeError(
          'NVENTRA_RESTORE_MAX_OUTPUT_BYTES',
          this.limits.outputBytes,
        );
      const out: Buffer[] = [];
      let nl: number;
      while (this.state !== 'done' && (nl = buf.indexOf(LF)) !== -1) {
        const line = buf.subarray(0, nl);
        if (line.length > this.limits.lineBytes)
          throw sizeError(
            'NVENTRA_RESTORE_MAX_LINE_BYTES',
            this.limits.lineBytes,
          );
        buf = buf.subarray(nl + 1);
        if (this.state === 'seek') {
          this.header(line.toString('latin1'));
        } else if (line.equals(END_MARKER)) {
          this.state = 'done';
        } else {
          out.push(line, Buffer.from([LF]));
        }
      }
      this.rest = this.state === 'done' ? Buffer.alloc(0) : buf;
      if (this.rest.length > this.limits.lineBytes)
        throw sizeError(
          'NVENTRA_RESTORE_MAX_LINE_BYTES',
          this.limits.lineBytes,
        );
      cb(null, out.length ? Buffer.concat(out) : undefined);
    } catch (err) {
      cb(err as Error);
    }
  }

  _flush(cb: TransformCallback) {
    if (this.state !== 'done') {
      cb(new RestoreVetError('a data section was incomplete'));
      return;
    }
    cb();
  }
}

/** Reads the one setval statement a SEQUENCE SET entry prints. */
export function parseSetval(
  output: string,
  liveSequences: ReadonlySet<string>,
): Setval {
  const hits = output
    .split('\n')
    .map((l) => SETVAL.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  const extra = output
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== '' &&
        !l.startsWith('--') &&
        !l.startsWith('SET ') &&
        !/^\\(un)?restrict [A-Za-z0-9]+$/.test(l) &&
        !SETVAL.test(l) &&
        !l.startsWith('SELECT pg_catalog.set_config('),
    );
  const m = hits[0];
  if (!m || hits.length !== 1 || extra.length || !liveSequences.has(m[1])) {
    throw new RestoreVetError('a sequence entry is not a plain setval');
  }
  const value = m[2];
  if (BigInt(value) > 9223372036854775807n) {
    throw new RestoreVetError('a sequence value is out of range');
  }
  return { sequence: m[1], value, called: m[3] === 'true' };
}

export interface LoadScriptInput {
  wipe: readonly string[];
  loads: { table: string; columns: string[]; file: string }[];
  setvals: Setval[];
  sequences: ReadonlyMap<string, SequenceInfo>;
}

/** The whole psql script, built only from validated pieces. */
export function buildLoadScript(i: LoadScriptInput): string {
  const lines = [
    "SET app.sync_origin = '__skip';", // do not replay the restore to sync peers
    "SET client_encoding = 'UTF8';",
    'SET search_path = pg_catalog, public;',
    "SET LOCAL lock_timeout = '10000ms';",
    "SET LOCAL statement_timeout = '900000ms';",
    ...(i.wipe.length
      ? [
          `LOCK TABLE ${i.wipe.map(qualified).join(', ')} IN ACCESS EXCLUSIVE MODE;`,
        ]
      : []),
    ...(i.wipe.includes('verifactu_records')
      ? [
          "DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.verifactu_records) THEN RAISE EXCEPTION 'Restore refused: nonempty append-only fiscal ledger'; END IF; END $$;",
        ]
      : []),
    ...sequencePreflight(i.sequences, i.setvals),
    ...i.wipe
      .filter((t) => t !== 'verifactu_records')
      .map((t) => `DELETE FROM ${qualified(t)};`),
    ...i.loads.map((l) => {
      const file = l.file.replace(/\\/g, '/');
      if (!SAFE_PATH.test(file)) {
        throw new Error('Refusing an unsafe temporary data file path');
      }
      return `\\copy ${qualified(l.table)} (${l.columns.map(ident).join(', ')}) FROM '${file}'`;
    }),
    ...sequenceReconciliation(i.sequences, i.setvals),
  ];
  return `${lines.join('\n')}\n`;
}

export interface LoadOptions {
  file: string;
  /** Allowed TOC lines, parents first (already vetted). */
  entries: readonly string[];
  url: string | undefined;
  workDir: string;
  wipe: readonly string[];
  columnsByTable: ReadonlyMap<string, ReadonlySet<string>>;
  sequences: ReadonlyMap<string, SequenceInfo>;
}

function entryList(workDir: string, n: number, line: string) {
  const p = path.join(workDir, `entry-${n}.list`);
  return fs.writeFile(p, `${line}\n`).then(() => p);
}

async function extractTable(
  o: LoadOptions,
  list: string,
  table: string,
  out: string,
  limits: RestoreLimits,
): Promise<{ columns: string[]; bytes: number }> {
  const env = { ...process.env, ...pgEnvFromUrl(o.url) };
  const child = spawn(
    'pg_restore',
    [
      '--data-only',
      '--no-owner',
      '--no-privileges',
      '-L',
      list,
      '-f',
      '-',
      o.file,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4096)
      stderr += d.toString().slice(0, 4096 - stderr.length);
  });
  let spawnError: Error | undefined;
  child.on('error', (err: Error) => {
    spawnError = err;
  });
  const exited = new Promise<number>((resolve) =>
    child.on('close', (c: number | null) => resolve(c ?? 1)),
  );
  const extractor = new CopyDataExtractor(
    table,
    o.columnsByTable.get(table)!,
    limits,
  );
  try {
    await pipeline(child.stdout, extractor, createWriteStream(out));
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    throw err;
  }
  if ((await exited) !== 0 || spawnError) {
    throw new Error(
      redactSecrets(
        `pg_restore extraction failed: ${spawnError ? 'could not start client' : stderr.trim()}`,
        knownDbSecrets(o.url),
      ),
    );
  }
  return { columns: extractor.columns, bytes: extractor.outputBytes };
}

/**
 * Extracts every allowed table's data to a file, then loads them all (after
 * deleting the current rows) in one psql transaction. Nothing destructive
 * happens until all extraction has succeeded; any later failure rolls back
 * the table rows. PostgreSQL sequence counters may retain forward gaps.
 */
export async function loadVettedData(o: LoadOptions): Promise<void> {
  const limits = restoreLimits((await fs.stat(o.file)).size);
  const loads: LoadScriptInput['loads'] = [];
  const setvals: Setval[] = [];
  let n = 0;
  let extractedBytes = 0;
  for (const line of o.entries) {
    const e = parseDataEntry(line);
    if (!e) continue;
    const list = await entryList(o.workDir, n, line);
    if (e.kind === 'TABLE DATA') {
      const dataFile = path.join(o.workDir, `data-${n}.copy`);
      const extracted = await extractTable(o, list, e.name, dataFile, {
        ...limits,
        outputBytes: limits.outputBytes - extractedBytes,
      });
      extractedBytes += extracted.bytes;
      loads.push({ table: e.name, columns: extracted.columns, file: dataFile });
    } else {
      const out = await runPg(
        'pg_restore',
        ['--data-only', '-L', list, '-f', '-', o.file],
        o.url,
      );
      extractedBytes += Buffer.byteLength(out);
      if (extractedBytes > limits.outputBytes)
        throw sizeError('NVENTRA_RESTORE_MAX_OUTPUT_BYTES', limits.outputBytes);
      const value = parseSetval(out, new Set(o.sequences.keys()));
      if (
        value.sequence !== e.name ||
        setvals.some((s) => s.sequence === value.sequence)
      ) {
        throw new RestoreVetError(
          'sequence data does not match its archive entry',
        );
      }
      setvals.push(value);
    }
    n += 1;
  }
  const script = path.join(o.workDir, 'load.sql');
  await fs.writeFile(
    script,
    buildLoadScript({ wipe: o.wipe, loads, setvals, sequences: o.sequences }),
  );
  await runPg(
    'psql',
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', script],
    o.url,
  );
}
