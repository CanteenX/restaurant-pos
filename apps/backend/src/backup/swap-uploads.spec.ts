import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { swapUploads } from './swap-uploads';

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

  it('puts the old uploads back when the copy fails', async () => {
    await expect(
      swapUploads(path.join(work, 'missing'), live, path.join(work, 'aside')),
    ).rejects.toBeTruthy();
    expect(await fs.readFile(path.join(live, 'old.txt'), 'utf8')).toBe('old');
  });
});
