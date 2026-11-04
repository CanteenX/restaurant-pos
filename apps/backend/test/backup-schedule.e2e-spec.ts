/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Local (folder / USB / NAS) scheduled backups, issue #29, against a real
// Postgres and the real pg_dump/tar binaries (pg_dump client must be >= the
// server major version). Writes only inside a throwaway temp root.
// Opt-in (needs a migrated + seeded database):
//   LOCAL_BACKUP_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- backup-schedule
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { parseChecksums } from './../src/backup/backup-integrity';
import { LocalBackupService } from './../src/backup/local-backup.service';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.LOCAL_BACKUP_E2E ? describe : describe.skip;
const sha = (p: string) =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const backupsIn = (dir: string) =>
  fs.readdirSync(dir).filter((n) => n.startsWith('nventra-backup-'));

run('Local scheduled backups (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let root: string;
  let outside: string;
  const startedAt = new Date();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nventra-local-backup-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nventra-outside-'));
    process.env.LOCAL_BACKUP_ROOT = root;
    process.env.UPLOADS_DIR = path.join(
      root,
      '..',
      path.basename(root) + '-uploads',
    );
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, 'logo.png'), 'png');

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.localBackupConfig.deleteMany({});
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await prisma?.localBackupConfig.deleteMany({});
    await prisma?.notification.deleteMany({
      where: { type: 'backup.local_failed', createdAt: { gte: startedAt } },
    });
    await app?.close();
    for (const d of [root, outside, process.env.UPLOADS_DIR!])
      fs.rmSync(d, { recursive: true, force: true });
    delete process.env.LOCAL_BACKUP_ROOT;
    delete process.env.UPLOADS_DIR;
  });

  it('requires backup.manage', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/backups/local/status')
      .expect(401);
  });

  it.each(['../etc', '/etc', 'usb/../../etc', '/tmp'])(
    'rejects directory %p outside the allowed root',
    async (directory) => {
      const res = await owner
        .put('/api/v1/backups/local/config')
        .send({ directory })
        .expect(400);
      expect(res.body.message).toMatch(/inside the allowed backup root/);
    },
  );

  it('defaults to daily with retention, enabled by LOCAL_BACKUP_ROOT', async () => {
    const res = await owner.get('/api/v1/backups/local/status').expect(200);
    expect(res.body).toMatchObject({
      enabled: true,
      root,
      directory: root,
      intervalHours: 24,
      retainCount: 7,
      lastSuccessAt: null,
    });
  });

  it('writes a verified backup (dump + uploads + SHA256SUMS) atomically', async () => {
    await owner
      .put('/api/v1/backups/local/config')
      .send({ directory: 'usb', retainCount: 2 })
      .expect(200);
    const res = await owner.post('/api/v1/backups/local/run').expect(201);
    const dir = path.join(root, 'usb');
    const [name] = backupsIn(dir);
    expect(name).toBeDefined();
    expect(
      fs.readdirSync(dir).filter((n) => n.startsWith('.partial-')),
    ).toEqual([]);

    const folder = path.join(dir, name);
    const sums = parseChecksums(
      fs.readFileSync(path.join(folder, 'SHA256SUMS'), 'utf8'),
    );
    expect(Object.keys(sums).sort()).toEqual(['db.dump', 'uploads.tar.gz']);
    for (const [file, hex] of Object.entries(sums))
      expect(sha(path.join(folder, file))).toBe(hex);
    // pg_dump custom format magic header.
    expect(
      fs.readFileSync(path.join(folder, 'db.dump')).subarray(0, 5).toString(),
    ).toBe('PGDMP');

    expect(res.body.lastSuccessPath).toBe(folder);
    const status = await owner.get('/api/v1/backups/local/status').expect(200);
    expect(
      new Date(status.body.lastSuccessAt).getTime(),
    ).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(status.body.backups).toEqual([name]);
    expect(new Date(status.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
  }, 60_000);

  it('the hourly check skips while not due and keeps only retainCount backups', async () => {
    const dir = path.join(root, 'usb');
    const svc = app.get(LocalBackupService);
    await svc.checkSchedule();
    expect(backupsIn(dir)).toHaveLength(1);

    await owner.post('/api/v1/backups/local/run').expect(201);
    await owner.post('/api/v1/backups/local/run').expect(201);
    expect(backupsIn(dir)).toHaveLength(2);
  }, 120_000);

  it('reports and notifies a failure when the directory is unwritable', async () => {
    // A plain file where the folder should be: unwritable even for root.
    fs.writeFileSync(path.join(root, 'blocked'), 'not a folder');
    await owner
      .put('/api/v1/backups/local/config')
      .send({ directory: 'blocked' })
      .expect(200);
    const res = await owner.post('/api/v1/backups/local/run').expect(500);
    expect(res.body.message).toMatch(/Local backup failed/);

    const status = await owner.get('/api/v1/backups/local/status').expect(200);
    expect(status.body.lastFailureAt).not.toBeNull();
    expect(status.body.lastFailureReason).toMatch(/EEXIST|ENOTDIR/);
    // Last good time survives the failure.
    expect(status.body.lastSuccessAt).not.toBeNull();

    const notes = await prisma.notification.findMany({
      where: {
        type: 'backup.local_failed',
        createdAt: { gte: startedAt },
        recipient: { email: 'owner@demo.local' },
      },
    });
    expect(notes.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('refuses a symlink that escapes the root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    await owner
      .put('/api/v1/backups/local/config')
      .send({ directory: 'escape' })
      .expect(200);
    const res = await owner.post('/api/v1/backups/local/run').expect(400);
    expect(res.body.message).toMatch(/inside the allowed backup root/);
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 60_000);

  it('creates nothing outside the root via a symlinked parent (link/sub)', async () => {
    await owner
      .put('/api/v1/backups/local/config')
      .send({ directory: 'escape/sub/deeper' })
      .expect(200);
    const res = await owner.post('/api/v1/backups/local/run').expect(400);
    expect(res.body.message).toMatch(/inside the allowed backup root/);
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 60_000);

  it('never leaks the database password when pg_dump fails', async () => {
    await owner
      .put('/api/v1/backups/local/config')
      .send({ directory: 'usb' })
      .expect(200);
    const realUrl = process.env.DATABASE_URL;
    const secret = 'S3cretPw-e2e';
    // Prisma is already connected; only the pg_dump child sees this URL.
    process.env.DATABASE_URL = `postgresql://nventra:${secret}@127.0.0.1:1/db`;
    const failStartedAt = new Date();
    let res: request.Response;
    try {
      res = await owner.post('/api/v1/backups/local/run').expect(500);
    } finally {
      process.env.DATABASE_URL = realUrl;
    }
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body.message).toMatch(/pg_dump failed/);

    const status = await owner.get('/api/v1/backups/local/status').expect(200);
    expect(status.body.lastFailureReason).toMatch(/pg_dump failed/);
    expect(JSON.stringify(status.body)).not.toContain(secret);

    const notes = await prisma.notification.findMany({
      where: {
        type: 'backup.local_failed',
        createdAt: { gte: failStartedAt },
      },
    });
    expect(notes.length).toBeGreaterThanOrEqual(1);
    for (const n of notes) expect(JSON.stringify(n)).not.toContain(secret);
  }, 60_000);

  it('reports lastSizeBytes as a number (BIGINT column)', async () => {
    const status = await owner.get('/api/v1/backups/local/status').expect(200);
    expect(typeof status.body.lastSizeBytes).toBe('number');
    expect(status.body.lastSizeBytes).toBeGreaterThan(0);
  });
});
