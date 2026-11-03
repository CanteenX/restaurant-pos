import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  CHECKSUM_FILE,
  checksumKeyFor,
  fetchVerifiedObjects,
  formatChecksums,
  parseChecksums,
  sha256Hex,
} from './backup-integrity';

// Minimal in-memory S3: just enough of `send()` for Get/Put commands.
function fakeS3(objects: Map<string, Buffer>) {
  const send = jest.fn((cmd: { input: { Key: string; Body?: Buffer } }) => {
    const name = cmd.constructor.name;
    if (name === 'PutObjectCommand') {
      objects.set(cmd.input.Key, cmd.input.Body!);
      return Promise.resolve({});
    }
    const body = objects.get(cmd.input.Key);
    if (!body) {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      return Promise.reject(err);
    }
    return Promise.resolve({ Body: Readable.from([body]) });
  });
  return { send } as unknown as S3Client;
}

const db = Buffer.from('pg dump bytes');
const uploads = Buffer.from('uploads tarball');

function storeWith(overrides: Partial<Record<string, Buffer>> = {}) {
  const objects = new Map<string, Buffer>([
    ['2026-11-03/db.dump', db],
    ['2026-11-03/uploads.tar.gz', uploads],
    [
      `2026-11-03/${CHECKSUM_FILE}`,
      Buffer.from(
        formatChecksums({
          'db.dump': sha256Hex(db),
          'uploads.tar.gz': sha256Hex(uploads),
        }),
      ),
    ],
  ]);
  for (const [k, v] of Object.entries(overrides)) objects.set(k, v!);
  return objects;
}

const record = {
  s3KeyDb: '2026-11-03/db.dump',
  s3KeyUploads: '2026-11-03/uploads.tar.gz',
  sha256: sha256Hex(db),
};

describe('backup integrity', () => {
  it('formats and parses sha256sum-compatible checksum files', () => {
    const text = formatChecksums({ 'db.dump': 'ab'.repeat(32) });
    expect(text).toBe(`${'ab'.repeat(32)}  db.dump\n`);
    expect(parseChecksums(text)).toEqual({ 'db.dump': 'ab'.repeat(32) });
  });

  it('places the checksum file beside the backup objects', () => {
    expect(checksumKeyFor('2026-11-03/db.dump')).toBe(
      `2026-11-03/${CHECKSUM_FILE}`,
    );
  });

  it('returns both objects when every checksum matches', async () => {
    const res = await fetchVerifiedObjects(fakeS3(storeWith()), 'b', record);
    expect(res.db.equals(db)).toBe(true);
    expect(res.uploads?.equals(uploads)).toBe(true);
    expect(parseChecksums(res.checksums)['db.dump']).toBe(sha256Hex(db));
  });

  it('rejects a corrupted db dump with a clear reason', async () => {
    const s3 = fakeS3(
      storeWith({ '2026-11-03/db.dump': Buffer.from('corrupt') }),
    );
    const err = await fetchVerifiedObjects(s3, 'b', record).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/checksum mismatch.*db\.dump/i);
  });

  it('rejects a corrupted uploads archive', async () => {
    const s3 = fakeS3(
      storeWith({ '2026-11-03/uploads.tar.gz': Buffer.from('bad') }),
    );
    await expect(fetchVerifiedObjects(s3, 'b', record)).rejects.toThrow(
      /checksum mismatch.*uploads\.tar\.gz/i,
    );
  });

  it('rejects when the checksum file disagrees with the recorded hash', async () => {
    await expect(
      fetchVerifiedObjects(fakeS3(storeWith()), 'b', {
        ...record,
        sha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/checksum mismatch.*db\.dump/i);
  });

  it('accepts a legacy backup with no checksum file using the recorded hash', async () => {
    const objects = storeWith();
    objects.delete(`2026-11-03/${CHECKSUM_FILE}`);
    const res = await fetchVerifiedObjects(fakeS3(objects), 'b', record);
    expect(res.db.equals(db)).toBe(true);
  });

  it('rejects a legacy backup whose db dump no longer matches', async () => {
    const objects = storeWith({ '2026-11-03/db.dump': Buffer.from('x') });
    objects.delete(`2026-11-03/${CHECKSUM_FILE}`);
    await expect(
      fetchVerifiedObjects(fakeS3(objects), 'b', record),
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('refuses a backup with no checksum at all', async () => {
    const objects = storeWith();
    objects.delete(`2026-11-03/${CHECKSUM_FILE}`);
    await expect(
      fetchVerifiedObjects(fakeS3(objects), 'b', { ...record, sha256: null }),
    ).rejects.toThrow(/no checksum/i);
  });
});
