import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
 * copied to `asideDir` first and put back if anything fails, so a failed
 * swap never leaves the uploads volume empty. Contents are emptied rather
 * than the directory removed: its parent may not be writable.
 */
export async function swapUploads(
  newRoot: string,
  liveDir: string,
  asideDir: string,
): Promise<void> {
  const hadOld = await fs
    .stat(liveDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (hadOld) await fs.cp(liveDir, asideDir, { recursive: true });
  try {
    await emptyDir(liveDir);
    await fs.cp(newRoot, liveDir, { recursive: true });
  } catch (err) {
    if (hadOld) {
      await emptyDir(liveDir);
      await fs.cp(asideDir, liveDir, { recursive: true });
    }
    throw err;
  }
}
