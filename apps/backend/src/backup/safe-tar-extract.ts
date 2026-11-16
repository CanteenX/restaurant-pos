import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default cap on the total uncompressed size of a restored archive. */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
const LIST_MAX_BUFFER = 256 * 1024 * 1024;

/** Thrown when an archive is refused; the message is safe to show in the UI. */
export class UnsafeArchiveError extends Error {
  constructor(reason: string) {
    super(`Backup archive rejected: ${reason}`);
    this.name = 'UnsafeArchiveError';
  }
}

export interface ExtractOptions {
  archivePath: string;
  /** The single top-level directory every entry must live under. */
  expectedRoot: string;
  /** Fresh directory to extract into; must not already exist. */
  destDir: string;
  maxUncompressedBytes?: number;
}

async function list(archivePath: string, verbose: boolean): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'tar',
      [verbose ? '-tvzf' : '-tzf', path.basename(archivePath)],
      // cwd + basename: GNU tar treats "C:\..." as a remote host.
      { maxBuffer: LIST_MAX_BUFFER, cwd: path.dirname(archivePath) },
    );
    return String(stdout)
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    throw new UnsafeArchiveError('it could not be read as a tar.gz archive');
  }
}

function checkName(raw: string, expectedRoot: string): void {
  const hasControlChar = [...raw].some((c) => c.charCodeAt(0) < 0x20);
  if (hasControlChar || raw.includes('\\')) {
    throw new UnsafeArchiveError(`unsafe characters in entry "${raw}"`);
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new UnsafeArchiveError(`absolute path "${raw}"`);
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new UnsafeArchiveError(`path traversal in "${raw}"`);
  }
  if (segments.length === 0 || segments[0] !== expectedRoot) {
    throw new UnsafeArchiveError(
      `entry "${raw}" is not under the single expected root "${expectedRoot}"`,
    );
  }
}

/**
 * Lists the archive and refuses it unless every entry is a regular file or
 * directory under exactly `expectedRoot`, with no absolute or `..` paths and
 * a sane total size. Returns nothing; throws UnsafeArchiveError.
 */
async function vetArchive(opts: ExtractOptions): Promise<void> {
  const names = await list(opts.archivePath, false);
  const verbose = await list(opts.archivePath, true);
  if (names.length === 0 || names.length !== verbose.length) {
    throw new UnsafeArchiveError('it is empty or its listing is inconsistent');
  }
  let total = 0;
  names.forEach((name, i) => {
    const line = verbose[i];
    const kind = line[0];
    if (kind !== '-' && kind !== 'd') {
      throw new UnsafeArchiveError(
        `"${name}" is a link or special file, which is not allowed`,
      );
    }
    if (kind === '-' && /\s(->|link to)\s/.test(line)) {
      throw new UnsafeArchiveError(`"${name}" is a link, which is not allowed`);
    }
    checkName(name, opts.expectedRoot);
    const size = Number(line.trim().split(/\s+/)[2]);
    if (!Number.isFinite(size)) {
      throw new UnsafeArchiveError(`could not read the size of "${name}"`);
    }
    total += size;
  });
  const max = opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  if (total > max) {
    throw new UnsafeArchiveError(
      `uncompressed size ${total} bytes exceeds the ${max} byte limit`,
    );
  }
}

/**
 * The only sanctioned way to extract a backup tarball. Vets the listing,
 * then extracts into a fresh `destDir` without restoring ownership or
 * permissions, and returns the path of the extracted root directory.
 * Fails closed: any doubt throws before anything is written.
 */
export async function extractVettedTarball(
  opts: ExtractOptions,
): Promise<string> {
  await vetArchive(opts);
  // mkdir without `recursive` fails if destDir exists, so it is always fresh.
  await fs.mkdir(opts.destDir);
  try {
    await execFileAsync(
      'tar',
      [
        '-xzf',
        path.basename(opts.archivePath),
        '-C',
        opts.destDir,
        '--no-same-owner',
        '--no-same-permissions',
      ],
      { cwd: path.dirname(opts.archivePath) },
    );
  } catch {
    await fs.rm(opts.destDir, { recursive: true, force: true });
    throw new UnsafeArchiveError('extraction failed');
  }
  return path.join(opts.destDir, opts.expectedRoot);
}
