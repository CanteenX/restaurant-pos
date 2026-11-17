import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  extractVettedTarball,
  UnsafeArchiveError,
} from './safe-tar-extract';

interface Entry {
  name: string;
  type?: string; // tar typeflag: '0' file, '5' dir, '2' symlink, '1' hardlink
  body?: string;
  linkname?: string;
  mode?: string; // octal, 7 digits
}

function header(e: Entry): Buffer {
  const h = Buffer.alloc(512);
  const body = Buffer.from(e.body ?? '');
  const type = e.type ?? '0';
  h.write(e.name, 0, 100, 'utf8');
  const mode = e.mode ?? (type === '5' ? '0000755' : '0000644');
  h.write(mode + '\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  const size = type === '0' ? body.length : 0;
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function buildTarGz(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e));
    if ((e.type ?? '0') === '0') {
      const body = Buffer.from(e.body ?? '');
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe('extractVettedTarball', () => {
  let work: string;
  let dest: string;
  beforeEach(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-tar-spec-'));
    dest = path.join(work, 'out');
  });
  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  async function run(entries: Entry[], maxBytes?: number) {
    const archive = path.join(work, 'a.tar.gz');
    await fs.writeFile(archive, buildTarGz(entries));
    return extractVettedTarball({
      archivePath: archive,
      expectedRoot: 'uploads',
      destDir: dest,
      maxUncompressedBytes: maxBytes,
    });
  }

  it('extracts a valid archive and returns the root path', async () => {
    const root = await run([
      { name: 'uploads/', type: '5' },
      { name: 'uploads/sub/', type: '5' },
      { name: 'uploads/sub/a.txt', body: 'hello' },
    ]);
    expect(root).toBe(path.join(dest, 'uploads'));
    expect(await fs.readFile(path.join(root, 'sub', 'a.txt'), 'utf8')).toBe(
      'hello',
    );
  });

  it.each([
    ['symlink', [{ name: 'uploads/l', type: '2', linkname: '/etc/passwd' }]],
    ['hardlink', [{ name: 'uploads/h', type: '1', linkname: 'uploads/a' }]],
    ['path traversal', [{ name: 'uploads/../../evil.txt', body: 'x' }]],
    ['absolute path', [{ name: '/etc/evil.txt', body: 'x' }]],
    [
      'two top-level roots',
      [
        { name: 'uploads/a.txt', body: 'x' },
        { name: 'other/b.txt', body: 'y' },
      ],
    ],
    ['wrong root name', [{ name: 'notuploads/a.txt', body: 'x' }]],
  ] as [string, Entry[]][])(
    'rejects %s and extracts nothing',
    async (_n, e) => {
      await expect(run(e)).rejects.toBeInstanceOf(UnsafeArchiveError);
      await expect(fs.stat(dest)).rejects.toBeTruthy();
      await expect(fs.stat(path.join(work, 'evil.txt'))).rejects.toBeTruthy();
    },
  );

  it('rejects a regular file where the root directory should be', async () => {
    await expect(run([{ name: 'uploads', body: 'hi' }])).rejects.toBeInstanceOf(
      UnsafeArchiveError,
    );
    await expect(fs.stat(dest)).rejects.toBeTruthy();
  });

  it('normalises unreadable modes so the tree can be copied', async () => {
    const root = await run([
      { name: 'uploads/', type: '5', mode: '0000000' },
      { name: 'uploads/d/', type: '5', mode: '0000000' },
      { name: 'uploads/d/f.txt', body: 'x', mode: '0000000' },
    ]);
    expect(await fs.readFile(path.join(root, 'd', 'f.txt'), 'utf8')).toBe('x');
    await fs.cp(root, path.join(work, 'copy'), { recursive: true });
  });

  it('does not echo raw or oversized entry names in the error', async () => {
    const evil = 'uploads/../' + 'A'.repeat(90) + '\u0007\u001b[31m';
    const err = await run([{ name: evil, body: 'x' }]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnsafeArchiveError);
    const msg = (err as Error).message;
    expect(msg).not.toContain('\u0007');
    expect(msg).not.toContain('A'.repeat(90));
  });

  it('honours the env-configurable size cap default', () => {
    expect(DEFAULT_MAX_UNCOMPRESSED_BYTES).toBeLessThanOrEqual(5 * 1024 ** 3);
  });

  it('rejects an archive over the size cap', async () => {
    await expect(
      run([{ name: 'uploads/big.bin', body: 'x'.repeat(2000) }], 1000),
    ).rejects.toThrow(/uncompressed size/);
  });

  it('rejects an empty or unreadable archive (fail closed)', async () => {
    await expect(run([])).rejects.toBeInstanceOf(UnsafeArchiveError);
    const bad = path.join(work, 'bad.tar.gz');
    await fs.writeFile(bad, 'not a tarball');
    await expect(
      extractVettedTarball({
        archivePath: bad,
        expectedRoot: 'uploads',
        destDir: dest,
      }),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);
  });
});
