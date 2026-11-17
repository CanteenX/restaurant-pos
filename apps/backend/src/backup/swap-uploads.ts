import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type CopyFn = (src: string, dst: string) => Promise<void>;

const defaultCopy: CopyFn = (src, dst) => fs.cp(src, dst, { recursive: true });

/** The swap failed AND the previous uploads could not be put back. */
export class UploadsRollbackError extends Error {
  constructor(
    readonly asideDir: string,
    cause: unknown,
  ) {
    super(
      `Restore failed and the previous uploads could not be put back. ` +
        `They are preserved at ${asideDir}; copy them back into the uploads ` +
        `directory manually. Cause: ${cause instanceof Error ? cause.message : 'unknown'}`,
    );
    this.name = 'UploadsRollbackError';
  }
}

async function emptyDir(dir: string): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries.map((e) =>
      fs.rm(path.join(dir, e), { recursive: true, force: true }),
    ),
  );
}

/**
 * Replaces the contents of `liveDir` with `newRoot`. The old contents are
 * copied to `asideDir` first and put back if anything fails. The aside copy
 * is deleted only after a successful swap or a successful rollback; if the
 * rollback itself fails it is left in place and its path is reported via
 * UploadsRollbackError. Contents are emptied rather than the directory
 * removed: its parent may not be writable.
 */
export async function swapUploads(
  newRoot: string,
  liveDir: string,
  asideDir: string,
  copy: CopyFn = defaultCopy,
): Promise<void> {
  const hadOld = await fs
    .stat(liveDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (hadOld) await copy(liveDir, asideDir);
  try {
    await emptyDir(liveDir);
    await copy(newRoot, liveDir);
  } catch (err) {
    if (hadOld) {
      try {
        await emptyDir(liveDir);
        await copy(asideDir, liveDir);
      } catch (rollbackErr) {
        throw new UploadsRollbackError(asideDir, rollbackErr);
      }
      await fs.rm(asideDir, { recursive: true, force: true });
    }
    throw err;
  }
  if (hadOld) await fs.rm(asideDir, { recursive: true, force: true });
}
