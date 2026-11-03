import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { BadRequestException, Logger } from '@nestjs/common';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * Backup integrity: every backup gets a `SHA256SUMS` file written beside its
 * objects (same format as `sha256sum`, so an owner can check a downloaded
 * copy with `sha256sum -c SHA256SUMS`), and every restore/download re-hashes
 * what it fetched before using it. A mismatch is a hard stop — a restore
 * never runs from bytes that differ from what was verified at backup time.
 */
export const CHECKSUM_FILE = 'SHA256SUMS';
export const DB_FILE = 'db.dump';
export const UPLOADS_FILE = 'uploads.tar.gz';

const logger = new Logger('BackupIntegrity');

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function formatChecksums(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, hex]) => `${hex}  ${name}\n`)
    .join('');
}

export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/** `2026-11-03T…/db.dump` → `2026-11-03T…/SHA256SUMS` */
export function checksumKeyFor(dbKey: string): string {
  const dir = path.posix.dirname(dbKey);
  return dir === '.' ? CHECKSUM_FILE : `${dir}/${CHECKSUM_FILE}`;
}

export function assertChecksum(name: string, buf: Buffer, expected: string) {
  const actual = sha256Hex(buf);
  if (actual !== expected.toLowerCase()) {
    throw new BadRequestException(
      `Backup checksum mismatch for ${name}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…. The backup is corrupt or was modified; nothing was restored.`,
    );
  }
}

export async function downloadBuffer(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>)
    chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function downloadOptional(s3: S3Client, bucket: string, key: string) {
  try {
    return await downloadBuffer(s3, bucket, key);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw err;
  }
}

export interface VerifiableBackup {
  s3KeyDb: string | null;
  s3KeyUploads: string | null;
  sha256: string | null;
}

export interface VerifiedObjects {
  db: Buffer;
  uploads: Buffer | null;
  /** Checksum file contents for the objects returned (always present). */
  checksums: string;
}

/**
 * Downloads a backup's objects and verifies each against its checksum file
 * and the hash recorded on the Backup row. Backups made before checksum
 * files existed are verified against the recorded db hash only (their
 * uploads archive cannot be checked, which is logged).
 */
export async function fetchVerifiedObjects(
  s3: S3Client,
  bucket: string,
  record: VerifiableBackup,
): Promise<VerifiedObjects> {
  if (!record.s3KeyDb) {
    throw new BadRequestException('Backup has no database dump');
  }
  const sumsBuf = await downloadOptional(
    s3,
    bucket,
    checksumKeyFor(record.s3KeyDb),
  );
  const sums = sumsBuf ? parseChecksums(sumsBuf.toString('utf8')) : {};
  const dbExpected = sums[DB_FILE] ?? record.sha256;
  if (!dbExpected) {
    throw new BadRequestException(
      'Backup has no checksum to verify against; refusing to use it.',
    );
  }
  if (record.sha256 && record.sha256 !== dbExpected) {
    throw new BadRequestException(
      `Backup checksum mismatch for ${DB_FILE}: the checksum file disagrees with the hash recorded at backup time; nothing was restored.`,
    );
  }

  const db = await downloadBuffer(s3, bucket, record.s3KeyDb);
  assertChecksum(DB_FILE, db, dbExpected);
  const entries: Record<string, string> = { [DB_FILE]: dbExpected };

  let uploads: Buffer | null = null;
  if (record.s3KeyUploads) {
    uploads = await downloadBuffer(s3, bucket, record.s3KeyUploads);
    const expected = sums[UPLOADS_FILE];
    if (expected) {
      assertChecksum(UPLOADS_FILE, uploads, expected);
    } else {
      logger.warn(
        `No checksum for ${record.s3KeyUploads} (backup predates checksum files); uploads archive is unverified`,
      );
    }
    entries[UPLOADS_FILE] = expected ?? sha256Hex(uploads);
  }
  return { db, uploads, checksums: formatChecksums(entries) };
}
