import * as fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import type { SessionUser } from '@nventra/types';
import { BackupService } from './backup.service';
import {
  CHECKSUM_FILE,
  formatChecksums,
  parseChecksums,
  sha256Hex,
} from './backup-integrity';

const execCalls: string[][] = [];
jest.mock('node:child_process', () => ({
  ...jest.requireActual<object>('node:child_process'),
  execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    execCalls.push([cmd, ...args]);
    const fileIdx = args.indexOf('--file');
    if (cmd === 'pg_dump' && fileIdx >= 0) {
      jest
        .requireActual<typeof import('node:fs')>('node:fs')
        .writeFileSync(args[fileIdx + 1], 'DUMP-BYTES');
    }
    const stdout =
      cmd === 'pg_restore' && args.includes('-l')
        ? '3345; 0 16400 TABLE DATA public Order nventra'
        : '';
    cb(null, { stdout, stderr: '' });
  },
}));
// No uploads directory, so only the db dump is in play.
jest.mock('../common/upload/image-upload.config', () => ({
  uploadsDir: () => '/nonexistent-nventra-uploads-for-test',
}));

const objects = new Map<string, Buffer>();
function installFakeS3() {
  jest.spyOn(S3Client.prototype, 'send').mockImplementation(((cmd: {
    input: { Key: string; Body?: Buffer };
  }) => {
    const kind = cmd.constructor.name;
    if (kind === 'PutObjectCommand') {
      objects.set(cmd.input.Key, Buffer.from(cmd.input.Body!));
      return Promise.resolve({});
    }
    if (kind === 'DeleteObjectCommand') {
      objects.delete(cmd.input.Key);
      return Promise.resolve({});
    }
    const body = objects.get(cmd.input.Key);
    if (!body) {
      const e = new Error('NoSuchKey');
      e.name = 'NoSuchKey';
      return Promise.reject(e);
    }
    return Promise.resolve({ Body: Readable.from([body]) });
  }) as never);
}

const owner = {
  id: 'u1',
  name: 'Owner',
  roleName: 'OWNER',
} as unknown as SessionUser;

function makeService() {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    backupConfig: {
      findUnique: jest.fn().mockResolvedValue({
        endpoint: 'http://s3.test',
        bucket: 'bkt',
        accessKeyId: 'a',
        secretAccessKey: 's',
        region: 'auto',
        intervalDays: 3,
        retainCount: 5,
      }),
    },
    backup: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'b1', createdAt: new Date(), ...data };
        rows.set('b1', row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: object }) => {
          const row = { ...rows.get(where.id), ...data };
          rows.set(where.id, row);
          return Promise.resolve(row);
        },
      ),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(() => Promise.resolve(rows.get('b1') ?? null)),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notifyUser: jest.fn() };
  const service = new BackupService(
    prisma as never,
    audit as never,
    notifications as never,
  );
  return { service, rows, audit };
}

describe('BackupService checksums', () => {
  beforeEach(() => {
    objects.clear();
    execCalls.length = 0;
    process.env.DATABASE_URL = 'postgresql://x:y@localhost:5432/anydb';
    installFakeS3();
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes a SHA256SUMS file beside every backup', async () => {
    const { service } = makeService();
    const done = await service.triggerManual(owner);

    const dbKey = done.s3KeyDb!;
    const sumsKey = dbKey.replace(/db\.dump$/, CHECKSUM_FILE);
    expect(objects.has(sumsKey)).toBe(true);
    const sums = parseChecksums(objects.get(sumsKey)!.toString());
    expect(sums['db.dump']).toBe(sha256Hex(Buffer.from('DUMP-BYTES')));
    expect(done.sha256).toBe(sums['db.dump']);
    expect(done.status).toBe('VERIFIED');
  });

  it('refuses a second restore while one is running, then allows another', async () => {
    const { service } = makeService();
    await service.triggerManual(owner);
    const first = service.restore(owner, 'b1', { confirm: 'RESTORE' });
    const second = await service
      .restore(owner, 'b1', { confirm: 'RESTORE' })
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ConflictException);
    await expect(first).resolves.toEqual({ ok: true, restoredFrom: 'b1' });
    await expect(
      service.restore(owner, 'b1', { confirm: 'RESTORE' }),
    ).resolves.toEqual({ ok: true, restoredFrom: 'b1' });
  });

  it('restores when the checksum matches', async () => {
    const { service } = makeService();
    await service.triggerManual(owner);
    const res = await service.restore(owner, 'b1', { confirm: 'RESTORE' });
    expect(res).toEqual({ ok: true, restoredFrom: 'b1' });
    expect(execCalls.some(([c]) => c === 'pg_restore')).toBe(true);
    expect(execCalls.flat().join(' ')).not.toContain('postgresql://');
  });

  it('never runs pg_restore on a checksum mismatch and reports why', async () => {
    const { service, audit } = makeService();
    const done = await service.triggerManual(owner);
    objects.set(done.s3KeyDb!, Buffer.from('TAMPERED'));

    const err = await service
      .restore(owner, 'b1', { confirm: 'RESTORE' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/checksum mismatch for db\.dump/i);
    expect(execCalls.some(([c]) => c === 'pg_restore')).toBe(false);
    const failed = (
      audit.record.mock.calls as [{ action: string; metadata: object }][]
    ).find(([i]) => i.action === 'backup.restore_failed');
    expect(failed?.[0].metadata).toMatchObject({
      error: expect.stringMatching(/checksum mismatch/i) as unknown,
    });
  });

  it('rejects a tampered checksum file too', async () => {
    const { service } = makeService();
    const done = await service.triggerManual(owner);
    objects.set(done.s3KeyDb!, Buffer.from('TAMPERED'));
    objects.set(
      done.s3KeyDb!.replace(/db\.dump$/, CHECKSUM_FILE),
      Buffer.from(
        formatChecksums({ 'db.dump': sha256Hex(Buffer.from('TAMPERED')) }),
      ),
    );
    await expect(
      service.restore(owner, 'b1', { confirm: 'RESTORE' }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(execCalls.some(([c]) => c === 'pg_restore')).toBe(false);
  });

  it('refuses to download a corrupt backup', async () => {
    const { service } = makeService();
    const done = await service.triggerManual(owner);
    objects.set(done.s3KeyDb!, Buffer.from('TAMPERED'));
    await expect(service.prepareDownload(owner, 'b1')).rejects.toThrow(
      /checksum mismatch/i,
    );
  });

  it('includes SHA256SUMS in a local export', async () => {
    const { service } = makeService();
    const out = await service.prepareLocalExport(owner);
    try {
      const sums = parseChecksums(await fs.readFile(out.checksumsPath, 'utf8'));
      expect(sums['db.dump']).toBe(sha256Hex(Buffer.from('DUMP-BYTES')));
    } finally {
      await fs.rm(out.workDir, { recursive: true, force: true });
    }
  });
});
