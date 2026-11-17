import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { swapUploads, UploadsRollbackError } from './swap-uploads';

describe('swapUploads', () => {
  let work: string;
  let live: string;
  let fresh: string;
  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'swap-uploads-spec-'));
    live = path.join(work, 'live');
    fresh = path.join(work, 'fresh');
    await fs.mkdir(live);
    await fs.mkdir(fresh);
    await fs.writeFile(path.join(live, 'old.txt'), 'old');
    await fs.writeFile(path.join(fresh, 'new.txt'), 'new');
  });
  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it('replaces the live contents with the new tree', async () => {
    await swapUploads(fresh, live, path.join(work, 'aside'));
    expect(await fs.readdir(live)).toEqual(['new.txt']);
  });

  it('keeps the set-aside copy and reports its path when rollback fails', async () => {
    const aside = path.join(work, 'aside');
    let calls = 0;
    const flaky = (src: string, dst: string) => {
      calls += 1;
      // 1: set-aside copy, 2: new tree, 3: rollback
      if (calls > 1) return Promise.reject(new Error('ENOSPC'));
      return fs.cp(src, dst, { recursive: true });
    };
    const err = await swapUploads(fresh, live, aside, flaky).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(UploadsRollbackError);
    expect((err as Error).message).toContain(aside);
    expect(await fs.readFile(path.join(aside, 'old.txt'), 'utf8')).toBe('old');
  });

  it('removes the set-aside copy after a successful swap', async () => {
    const aside = path.join(work, 'aside');
    await swapUploads(fresh, live, aside);
    await expect(fs.stat(aside)).rejects.toBeTruthy();
  });

  it('puts the old uploads back when the copy fails', async () => {
    await expect(
      swapUploads(path.join(work, 'missing'), live, path.join(work, 'aside')),
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(live, 'old.txt'), 'utf8')).toBe('old');
  });
});
