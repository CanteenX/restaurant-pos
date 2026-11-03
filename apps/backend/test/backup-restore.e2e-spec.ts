/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Backup restore DRILL against a real Postgres: seed -> backup -> wipe ->
// restore -> the same rows are back and login works. Also proves a corrupt
// backup is refused before pg_restore touches anything.
//
// Runs in its OWN throwaway database (created next to the one in
// DATABASE_URL, migrated + seeded, dropped afterwards), so the wipe can never
// touch a shared/dev database, and the DB name is derived, not hardcoded.
// S3 is an in-memory fake; pg_dump/pg_restore are the real binaries (client
// must be >= the server major version). Opt-in:
//   BACKUP_DRILL_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand backup-restore
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import type { SessionUser } from '@nventra/types';
import { AppModule } from './../src/app.module';
import { AuditService } from './../src/audit/audit.service';
import { BackupService } from './../src/backup/backup.service';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.BACKUP_DRILL_E2E ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEEP = new Set(['_prisma_migrations', 'backups', 'backup_config']);

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

run('Backup restore drill (e2e)', () => {
  const originalUrl = process.env.DATABASE_URL!;
  const drillUrl = new URL(originalUrl);
  drillUrl.pathname = `/${drillUrl.pathname.slice(1)}_drill_${tag}`;
  const drillDb = drillUrl.pathname.slice(1);
  const admin = new PrismaClient({ datasourceUrl: originalUrl });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let ownerSession: SessionUser;
  let backupId: string;
  let dbKey: string;

  const counts = async () => ({
    restaurants: await prisma.restaurant.count(),
    users: await prisma.user.count(),
    menuItems: await prisma.menuItem.count(),
    orders: await prisma.order.count(),
    customers: await prisma.customer.count(),
  });
  const login = async () => {
    const a = request.agent(app.getHttpServer());
    await a
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    return a;
  };

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${drillDb}"`);
    const env = { ...process.env, DATABASE_URL: drillUrl.toString() };
    const cwd = path.join(__dirname, '..');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd, env });
    execFileSync('npx', ['ts-node', 'prisma/seed.ts'], { cwd, env });

    process.env.DATABASE_URL = drillUrl.toString();
    process.env.S3_BACKUP_ENDPOINT = 'http://s3.drill.invalid';
    process.env.S3_BACKUP_BUCKET = 'drill';
    process.env.S3_BACKUP_ACCESS_KEY_ID = 'drill';
    process.env.S3_BACKUP_SECRET_ACCESS_KEY = 'drill';
    installFakeS3();

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

    await prisma.customer.create({
      data: {
        branchId: 'demo-branch',
        name: `Drill ${tag}`,
        phone: '9000000001',
      },
    });
    owner = await login();
    ownerSession = (await owner.get('/api/v1/auth/me').expect(200)).body.user;
    expect(ownerSession.roleName).toBe('OWNER');
  }, 180_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    process.env.DATABASE_URL = originalUrl;
    for (const k of [
      'ENDPOINT',
      'BUCKET',
      'ACCESS_KEY_ID',
      'SECRET_ACCESS_KEY',
    ])
      delete process.env[`S3_BACKUP_${k}`];
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${drillDb}" WITH (FORCE)`,
    );
    await admin.$disconnect();
  });

  it('takes a verified backup with a SHA256SUMS file beside it', async () => {
    const res = await owner.post('/api/v1/backups').expect(201);
    expect(res.body.status).toBe('VERIFIED');
    backupId = res.body.id;
    dbKey = res.body.s3KeyDb;
    const sums = objects.get(dbKey.replace(/db\.dump$/, 'SHA256SUMS'));
    expect(sums?.toString()).toContain(`${res.body.sha256}  db.dump`);
  });

  it('refuses a corrupt backup, says why, and leaves the data alone', async () => {
    const before = await counts();
    const good = objects.get(dbKey)!;
    objects.set(dbKey, Buffer.concat([good, Buffer.from('x')]));
    try {
      const res = await owner
        .post(`/api/v1/backups/${backupId}/restore`)
        .send({ confirm: 'RESTORE' })
        .expect(400);
      expect(res.body.message).toMatch(/checksum mismatch for db\.dump/i);
      const dl = await owner.get(`/api/v1/backups/${backupId}/download`);
      expect(dl.status).toBe(400);
    } finally {
      objects.set(dbKey, good);
    }
    expect(await counts()).toEqual(before);
  });

  it('backup -> wipe -> restore brings every key table back', async () => {
    const before = await counts();
    expect(before.orders).toBeGreaterThan(0);
    expect(before.customers).toBeGreaterThan(0);

    const catalogue = await prisma.backup.findUniqueOrThrow({
      where: { id: backupId },
    });
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const wipe = tables
      .map((t) => t.tablename)
      .filter((t) => !KEEP.has(t))
      .map((t) => `"public"."${t}"`);
    // Append-only audit tables (e.g. verifactu_records) refuse TRUNCATE via a
    // trigger; a disaster does not ask permission, so bypass triggers for
    // this one transaction (the ci role is a superuser).
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRawUnsafe(`TRUNCATE ${wipe.join(', ')} CASCADE`),
    ]);
    // TRUNCATE ... CASCADE also empties `backups` (FK to users). Put the
    // catalogue entry back, as an owner would from the bucket's listing.
    await prisma.backup.create({ data: { ...catalogue, triggeredById: null } });
    expect(await counts()).toEqual({
      restaurants: 0,
      users: 0,
      menuItems: 0,
      orders: 0,
      customers: 0,
    });

    // The DB is empty, so no session can authenticate and the acting user's
    // row (audit FK) does not exist until the restore puts it back: call the
    // service directly and let pre-restore audit writes fail softly.
    const audit = app.get(AuditService);
    const realRecord: AuditService['record'] = audit.record.bind(audit);
    const spy = jest
      .spyOn(audit, 'record')
      .mockImplementation((input) => realRecord(input).catch(() => undefined));
    try {
      await app
        .get(BackupService)
        .restore(ownerSession, backupId, { confirm: 'RESTORE' });
    } finally {
      spy.mockRestore();
    }

    expect(await counts()).toEqual(before);
    const again = await login();
    const items = await again
      .get('/api/v1/menu/items?branchId=demo-branch')
      .expect(200);
    expect(items.body.length).toBe(before.menuItems);
  }, 120_000);
});
