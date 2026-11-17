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
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { dumpDatabase, restoreDatabase } from './../src/backup/pg-exec';
import { pgEnvFromUrl } from './../src/backup/pg-env';

const run = process.env.BACKUP_DRILL_E2E ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const KEEP = new Set(['_prisma_migrations', 'backups', 'backup_config']);
const hindiName = 'परीक्षण ग्राहक — गरम चाय ₹२५०';
const hindiDescription = 'घर की बनी पनीर सब्ज़ी, ₹250.50; स्वागत है 🥘';
const literalCommands =
  '\\.\n\\! touch /tmp/nventra-literal-client\n' +
  "COPY (SELECT '') TO PROGRAM 'touch /tmp/nventra-literal-server';";

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
  let customerId: string;
  let menuId: string;
  let scratch: string;
  let restoreUrl: string;

  const snapshot = async () => ({
    counts: await counts(),
    customer: await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    }),
    probe: await prisma.$queryRawUnsafe<{ id: number; note: string }[]>(
      'SELECT * FROM drill_probe ORDER BY id',
    ),
    sequence: await prisma.$queryRawUnsafe<
      { last_value: bigint; is_called: boolean }[]
    >('SELECT last_value, is_called FROM drill_probe_id_seq'),
  });

  const directoryDump = () => {
    const directory = path.join(scratch, randomUUID());
    execFileSync(
      'pg_dump',
      ['--format=directory', '--compress=0', '--file', directory],
      {
        env: { ...process.env, ...pgEnvFromUrl(drillUrl.toString()) },
        stdio: 'pipe',
      },
    );
    return directory;
  };

  const assertRestoredText = async () => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(customer.name).toBe(hindiName);
    expect(customer.address).toBe(hindiDescription);
    expect(customer.notes).toBe(literalCommands);
    const item = await prisma.menuItem.findUniqueOrThrow({
      where: { id: menuId },
    });
    expect(item.name).toBe('मसाला चाय ₹२५०');
    expect(item.description).toBe(hindiDescription);
    expect(item.price.toFixed(2)).toBe('250.50');
    assertLinuxMarkerAbsent('/tmp/nventra-literal-client');
    assertLinuxMarkerAbsent('/tmp/nventra-literal-server');
  };

  const assertLinuxMarkerAbsent = (marker: string) => {
    // Commands execute in the Linux client/server container, so checking only
    // the Windows host would miss the original exploit.
    const docker = process.env.BACKUP_DRILL_DOCKER;
    const container = process.env.BACKUP_DRILL_CONTAINER;
    if (docker && container) {
      expect(() =>
        execFileSync(docker, ['exec', container, 'test', '!', '-e', marker], {
          stdio: 'pipe',
        }),
      ).not.toThrow();
    } else {
      expect(process.platform).not.toBe('win32');
      expect(fs.existsSync(marker)).toBe(false);
    }
  };

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
    execFileSync(
      process.execPath,
      [
        path.join(cwd, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      { cwd, env, stdio: 'pipe' },
    );
    // Demo seeding prints its disposable login password: suppress all seed
    // output, including failures, so it never enters drill logs.
    try {
      execFileSync(
        process.execPath,
        [path.join(cwd, 'node_modules/ts-node/dist/bin.js'), 'prisma/seed.ts'],
        { cwd, env, stdio: 'pipe' },
      );
    } catch {
      throw new Error('Isolated drill seed failed (output suppressed)');
    }

    const limited = new URL(drillUrl);
    limited.username = 'nventra_restore';
    limited.password = '';
    restoreUrl = limited.toString();
    process.env.DATABASE_RESTORE_URL = restoreUrl;
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-drill-'));
    await admin.$executeRawUnsafe(
      'CREATE ROLE nventra_restore LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS',
    );

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

    const migrationCount = await prisma.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(Number(migrationCount[0].count)).toBe(69);
    await prisma.$executeRawUnsafe(
      'CREATE TABLE drill_probe (id serial PRIMARY KEY, other serial NOT NULL, note text NOT NULL)',
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO drill_probe (note) VALUES ('snapshot row')",
    );
    await prisma.$executeRawUnsafe(
      'GRANT USAGE ON SCHEMA public TO nventra_restore',
    );
    await prisma.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nventra_restore',
    );
    await prisma.$executeRawUnsafe(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO nventra_restore',
    );
    const customer = await prisma.customer.create({
      data: {
        branchId: 'demo-branch',
        name: hindiName,
        phone: '9000000001',
        address: hindiDescription,
        notes: literalCommands,
      },
    });
    customerId = customer.id;
    const item = await prisma.menuItem.findFirstOrThrow();
    menuId = item.id;
    await prisma.menuItem.update({
      where: { id: menuId },
      data: {
        name: 'मसाला चाय ₹२५०',
        description: hindiDescription,
        price: '250.50',
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
    delete process.env.DATABASE_RESTORE_URL;
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
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
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
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });
    expect(customer.name).toBe(hindiName);
    expect(customer.address).toBe(hindiDescription);
    expect(customer.notes).toBe(literalCommands);
    const item = await prisma.menuItem.findUniqueOrThrow({
      where: { id: menuId },
    });
    expect(item.name).toBe('मसाला चाय ₹२५०');
    expect(item.description).toBe(hindiDescription);
    expect(item.price.toFixed(2)).toBe('250.50');
    assertLinuxMarkerAbsent('/tmp/nventra-literal-client');
    assertLinuxMarkerAbsent('/tmp/nventra-literal-server');
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
    await assertRestoredText();
    const again = await login();
    const items = await again
      .get('/api/v1/menu/items?branchId=demo-branch')
      .expect(200);
    expect(items.body.length).toBe(before.menuItems);
  }, 120_000);

  it('refuses a role with database CREATE privilege before deleting rows', async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe(
      `GRANT CREATE ON DATABASE "${drillDb}" TO nventra_restore`,
    );
    try {
      const dump = path.join(scratch, 'dbcreate.dump');
      await dumpDatabase(dump);
      await expect(restoreDatabase(dump)).rejects.toThrow(
        /elevated|privilege|CREATE/i,
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(
        `REVOKE CREATE ON DATABASE "${drillDb}" FROM nventra_restore`,
      );
    }
  }, 120_000);

  it('refuses a role owning a public function before deleting rows', async () => {
    const before = await snapshot();
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION drill_owned_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    );
    await prisma.$executeRawUnsafe(
      'ALTER FUNCTION drill_owned_function() OWNER TO nventra_restore',
    );
    try {
      const dump = path.join(scratch, 'function-owner.dump');
      await dumpDatabase(dump);
      await expect(restoreDatabase(dump)).rejects.toThrow(
        /elevated|privilege|own/i,
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe('DROP FUNCTION drill_owned_function()');
    }
  }, 120_000);

  it('keeps rows and never rewinds a sequence when a deferred constraint rejects COMMIT', async () => {
    const dump = path.join(scratch, 'deferred-failure.dump');
    await dumpDatabase(dump);
    await prisma.$executeRawUnsafe(
      "UPDATE drill_probe SET note = 'live row survives failed restore'",
    );
    await prisma.$executeRawUnsafe(
      "SELECT setval('drill_probe_id_seq', 500, true)",
    );
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION drill_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'drill deferred commit failure'; END $$",
    );
    await prisma.$executeRawUnsafe(
      'CREATE CONSTRAINT TRIGGER drill_fail_commit AFTER INSERT ON drill_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION drill_fail_commit()',
    );
    const before = await snapshot();
    try {
      await expect(restoreDatabase(dump)).rejects.toThrow(
        /drill deferred commit failure/,
      );
      const after = await snapshot();
      expect(after.counts).toEqual(before.counts);
      expect(after.customer).toEqual(before.customer);
      expect(after.probe).toEqual(before.probe);
      expect(after.sequence[0].last_value).toBeGreaterThanOrEqual(500n);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER drill_fail_commit ON drill_probe',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION drill_fail_commit()');
    }
    const generated = await prisma.$queryRawUnsafe<{ id: number }[]>(
      "INSERT INTO drill_probe(note) VALUES ('next id after rollback') RETURNING id",
    );
    expect(generated[0].id).toBeGreaterThanOrEqual(501);
  }, 120_000);

  it('never interprets hostile COPY-ending CRLF, psql meta commands or server commands', async () => {
    const directory = directoryDump();
    const clientMarker = `/tmp/nventra-hostile-client-${tag}`;
    const serverMarker = `/tmp/nventra-hostile-server-${tag}`;
    const dataFile = fs
      .readdirSync(directory)
      .filter((file) => file.endsWith('.dat'))
      .map((file) => path.join(directory, file))
      .find((file) => fs.readFileSync(file).includes(Buffer.from(customerId)));
    expect(dataFile).toBeDefined();
    const original = fs.readFileSync(dataFile!);
    const terminator = original.lastIndexOf(Buffer.from('\\.\n'));
    expect(terminator).toBeGreaterThan(0);
    const attack = Buffer.from(
      `\\.\r\n\\! touch ${clientMarker}\nCOPY (SELECT '') TO PROGRAM 'touch ${serverMarker}';\n`,
    );
    fs.writeFileSync(
      dataFile!,
      Buffer.concat([
        original.subarray(0, terminator),
        attack,
        original.subarray(terminator),
      ]),
    );
    const before = await snapshot();
    try {
      await restoreDatabase(directory);
      expect(await counts()).toEqual(before.counts);
      await assertRestoredText();
    } catch {
      // Both safely ignoring trailing COPY payload and rejecting it are valid;
      // failure must leave original application rows intact.
      const after = await snapshot();
      expect(after.counts).toEqual(before.counts);
      expect(after.customer).toEqual(before.customer);
      expect(after.probe).toEqual(before.probe);
    }
    assertLinuxMarkerAbsent(clientMarker);
    assertLinuxMarkerAbsent(serverMarker);
  }, 120_000);

  it('validates every sequence range before deleting rows or changing any counter', async () => {
    const directory = directoryDump();
    const tocFile = path.join(directory, 'toc.dat');
    const toc = fs.readFileSync(tocFile);
    const setval = Buffer.from(
      "SELECT pg_catalog.setval('public.drill_probe_other_seq', ",
    );
    const offset = toc.indexOf(setval);
    expect(offset).toBeGreaterThan(0);
    // Replace one decimal digit without changing binary TOC string lengths.
    const digit = offset + setval.length;
    expect(toc[digit]).toBeGreaterThanOrEqual(0x31);
    toc[digit] = 0x30;
    fs.writeFileSync(tocFile, toc);
    const before = await snapshot();
    const otherBefore = await prisma.$queryRawUnsafe(
      'SELECT last_value, is_called FROM drill_probe_other_seq',
    );
    await expect(restoreDatabase(directory)).rejects.toThrow(
      /sequence|range|bound/i,
    );
    expect(await snapshot()).toEqual(before);
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT last_value, is_called FROM drill_probe_other_seq',
      ),
    ).toEqual(otherBefore);
  }, 120_000);

  it('preserves live counters and advances beyond copied row IDs when archive counters lag', async () => {
    await prisma.$executeRawUnsafe(
      "INSERT INTO drill_probe(id, other, note) VALUES (5000, 5000, 'copied high id')",
    );
    const dump = path.join(scratch, 'lagging-counters.dump');
    await dumpDatabase(dump);
    await prisma.$executeRawUnsafe(
      "SELECT setval('drill_probe_id_seq', 1000, true)",
    );
    await restoreDatabase(dump);
    const inserted = await prisma.$queryRawUnsafe<
      { id: number; other: number }[]
    >(
      "INSERT INTO drill_probe(note) VALUES ('after high restored id') RETURNING id, other",
    );
    expect(inserted[0].id).toBeGreaterThan(5000);
    expect(inserted[0].other).toBeGreaterThan(5000);
  }, 120_000);

  it('refuses nonempty fiscal ledgers and preserves their append-only guards', async () => {
    const dump = path.join(scratch, 'before-fiscal.dump');
    await dumpDatabase(dump);
    const record = await prisma.verifactuRecord.create({
      data: {
        restaurantId: 'demo-restaurant',
        branchId: 'demo-branch',
        issuerNif: 'DISPOSABLE-DRILL',
        seq: 1,
        type: 'ALTA',
        invoiceType: 'F2',
        invoiceNumber: `DRILL-${tag}`,
        issueDate: '17-11-2026',
        taxTotalCents: 0,
        totalCents: 0,
        generatedAt: '2026-11-17T00:00:00+00:00',
        hash: '0'.repeat(64),
        xml: '<isolated-drill/>',
        environment: 'TEST',
      },
    });
    const before = await snapshot();
    await expect(restoreDatabase(dump)).rejects.toThrow(
      /append-only|fiscal ledger|not empty/i,
    );
    expect(await snapshot()).toEqual(before);
    expect(
      await prisma.verifactuRecord.findUniqueOrThrow({
        where: { id: record.id },
      }),
    ).toEqual(record);
    await expect(
      prisma.verifactuRecord.delete({ where: { id: record.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.verifactuRecord.update({
        where: { id: record.id },
        data: { totalCents: 1 },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE verifactu_records'),
    ).rejects.toThrow(/append-only/);
    expect(
      await prisma.verifactuRecord.findUniqueOrThrow({
        where: { id: record.id },
      }),
    ).toEqual(record);
  }, 120_000);
});
