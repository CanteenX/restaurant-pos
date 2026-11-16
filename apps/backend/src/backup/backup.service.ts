import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  RestoreBackupDto,
  SessionUser,
  SetBackupConfigDto,
} from '@nventra/types';
import { AuditService } from '../audit/audit.service';
import type { NotifyPayload } from '../notifications/notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { uploadsDir } from '../common/upload/image-upload.config';
import { notifyOwners } from './notify-owners';
import { extractVettedTarball, UnsafeArchiveError } from './safe-tar-extract';
import {
  CHECKSUM_FILE,
  DB_FILE,
  UPLOADS_FILE,
  checksumKeyFor,
  downloadBuffer,
  fetchVerifiedObjects,
  formatChecksums,
  sha256Hex,
} from './backup-integrity';

const execFileAsync = promisify(execFile);
const CONFIG_ID = 'singleton';

interface EffectiveConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  intervalDays: number;
  retainCount: number;
  source: 'database' | 'environment';
}

function mask(value: string): string {
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

/**
 * Full-instance backup (Postgres + the uploads volume) to any S3-compatible
 * bucket, ported from zulivio's real, working `backup/` module
 * (~/zulivio/apps/backend/src/backup/) and adapted to this repo's
 * conventions: Zod schemas from @nventra/types instead of
 * class-validator DTOs, `AuditService`/`NotificationsService` instead of
 * zulivio's audit/notification equivalents, and a permission-key gate
 * (`backup.manage`, checked by the controller's `@Auth()`) instead of
 * zulivio's `RolesGuard` + `Role.MASTER_OWNER` enum check.
 *
 * Instance-wide by design — a `pg_dump` of the shared Postgres instance
 * covers every `Restaurant` row, not one tenant, so there is no
 * restaurantId/branchId to scope any of this to. See `requireOwner()`
 * below for why *restore* specifically gets an extra, deliberately
 * hardcoded role-name check beyond the standard permission guard.
 *
 * Config resolved two ways, checked in this order: a row in
 * `backup_config` (settable from Settings > Backup, so the app is
 * self-contained — no .env/CasaOS editing required once connected),
 * falling back to `S3_BACKUP_*` env vars (same names zulivio uses, for
 * operational consistency across both apps).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async getConfig(): Promise<EffectiveConfig | null> {
    const row = await this.prisma.backupConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    if (row) {
      return {
        endpoint: row.endpoint,
        bucket: row.bucket,
        accessKeyId: row.accessKeyId,
        secretAccessKey: row.secretAccessKey,
        region: row.region,
        intervalDays: row.intervalDays,
        retainCount: row.retainCount,
        source: 'database',
      };
    }

    const {
      S3_BACKUP_ENDPOINT,
      S3_BACKUP_BUCKET,
      S3_BACKUP_ACCESS_KEY_ID,
      S3_BACKUP_SECRET_ACCESS_KEY,
    } = process.env;
    if (
      S3_BACKUP_ENDPOINT &&
      S3_BACKUP_BUCKET &&
      S3_BACKUP_ACCESS_KEY_ID &&
      S3_BACKUP_SECRET_ACCESS_KEY
    ) {
      return {
        endpoint: S3_BACKUP_ENDPOINT,
        bucket: S3_BACKUP_BUCKET,
        accessKeyId: S3_BACKUP_ACCESS_KEY_ID,
        secretAccessKey: S3_BACKUP_SECRET_ACCESS_KEY,
        region: process.env.S3_BACKUP_REGION ?? 'auto',
        intervalDays: Number(process.env.S3_BACKUP_INTERVAL_DAYS ?? 3),
        retainCount: Number(process.env.S3_BACKUP_RETAIN_COUNT ?? 2),
        source: 'environment',
      };
    }

    return null;
  }

  private async requireConfig(): Promise<EffectiveConfig> {
    const config = await this.getConfig();
    if (!config) {
      throw new BadRequestException(
        'S3 backup is not configured. Add your S3 endpoint, bucket, and access key in Settings > Backup.',
      );
    }
    return config;
  }

  private s3Client(config: EffectiveConfig): S3Client {
    return new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  // Belt-and-suspenders gate for restore specifically. Every other
  // @Auth()-gated action in this codebase checks a *permission key*, never
  // a role name (see roles.service.ts's own comment on why Role.name is
  // free-form since Phase 2) — but restore is categorically different from
  // everything else `backup.manage` also gates (trigger/list/download):
  // PermissionsSyncService auto-grants EVERY permission, including
  // `backup.manage`, to both the OWNER and ADMINISTRATOR role of every
  // restaurant on this instance (see permissions-sync.service.ts's
  // `ALWAYS_FULL_ACCESS_ROLES`). Because backups/restores are instance-wide
  // — not scoped to the caller's own restaurant — relying on the
  // permission guard alone would let any restaurant's Administrator (or a
  // future custom role explicitly granted `backup.manage` for legitimate
  // trigger/download access) drop and recreate the ENTIRE shared Postgres
  // instance, silently overwriting every OTHER restaurant's data too. That
  // blast radius is unique to this one endpoint, so it gets the one
  // deliberately hardcoded role-name check in this whole feature —
  // matching both zulivio's own `requireMasterOwner()` precedent and this
  // codebase's own precedent for infra-level role checks
  // (`ALWAYS_FULL_ACCESS_ROLES` itself compares `role.name` directly).
  private requireOwner(user: SessionUser) {
    if (user.roleName !== 'OWNER') {
      throw new ForbiddenException('Only the Owner can restore a backup');
    }
  }

  async status() {
    const [config, lastVerified, lastAny] = await Promise.all([
      this.getConfig(),
      this.prisma.backup.findFirst({
        where: { status: 'VERIFIED' },
        orderBy: { verifiedAt: 'desc' },
      }),
      this.prisma.backup.findFirst({ orderBy: { createdAt: 'desc' } }),
    ]);

    const nextScheduledAt =
      config && lastVerified?.verifiedAt
        ? new Date(
            lastVerified.verifiedAt.getTime() +
              config.intervalDays * 24 * 60 * 60 * 1000,
          )
        : null;

    return {
      configured: config !== null,
      source: config?.source ?? null,
      endpoint: config?.endpoint ?? null,
      bucket: config?.bucket ?? null,
      region: config?.region ?? null,
      accessKeyIdMasked: config ? mask(config.accessKeyId) : null,
      intervalDays: config?.intervalDays ?? 3,
      retainCount: config?.retainCount ?? 2,
      lastBackup: lastAny,
      nextScheduledAt,
    };
  }

  list() {
    return this.prisma.backup.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Saves S3 credentials from Settings, but only after a live connectivity
   * check (put + get + delete a small probe object) — surfacing a bad
   * endpoint/bucket/key immediately is much better than finding out three
   * days later when the scheduled backup silently fails.
   */
  async setConfig(user: SessionUser, dto: SetBackupConfigDto) {
    const candidate: EffectiveConfig = {
      endpoint: dto.endpoint,
      bucket: dto.bucket,
      accessKeyId: dto.accessKeyId,
      secretAccessKey: dto.secretAccessKey,
      region: dto.region ?? 'auto',
      intervalDays: dto.intervalDays ?? 3,
      retainCount: dto.retainCount ?? 2,
      source: 'database',
    };

    const s3 = this.s3Client(candidate);
    const probeKey = `connectivity-check/${Date.now()}.txt`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: candidate.bucket,
          Key: probeKey,
          Body: Buffer.from('ok'),
        }),
      );
      await downloadBuffer(s3, candidate.bucket, probeKey);
      await s3.send(
        new DeleteObjectCommand({ Bucket: candidate.bucket, Key: probeKey }),
      );
    } catch (err) {
      throw new BadRequestException(
        `Could not connect to that bucket: ${(err as Error).message}`,
      );
    }

    await this.prisma.backupConfig.upsert({
      where: { id: CONFIG_ID },
      create: {
        id: CONFIG_ID,
        endpoint: candidate.endpoint,
        bucket: candidate.bucket,
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey,
        region: candidate.region,
        intervalDays: candidate.intervalDays,
        retainCount: candidate.retainCount,
        updatedById: user.id,
      },
      update: {
        endpoint: candidate.endpoint,
        bucket: candidate.bucket,
        accessKeyId: candidate.accessKeyId,
        secretAccessKey: candidate.secretAccessKey,
        region: candidate.region,
        intervalDays: candidate.intervalDays,
        retainCount: candidate.retainCount,
        updatedById: user.id,
      },
    });

    await this.audit.record({
      userId: user.id,
      action: 'backup.config_updated',
      entity: 'BackupConfig',
      metadata: {
        endpoint: candidate.endpoint,
        bucket: candidate.bucket,
        region: candidate.region,
        intervalDays: candidate.intervalDays,
        retainCount: candidate.retainCount,
      },
    });

    return this.status();
  }

  async clearConfig(user: SessionUser) {
    await this.prisma.backupConfig.deleteMany({ where: { id: CONFIG_ID } });
    await this.audit.record({
      userId: user.id,
      action: 'backup.config_cleared',
      entity: 'BackupConfig',
    });
    return this.status();
  }

  async triggerManual(user: SessionUser) {
    const config = await this.requireConfig();
    return this.runBackup(config, user.id);
  }

  /**
   * Checked hourly rather than scheduled directly on a multi-day cron, so
   * the interval survives container restarts (a plain N-day timer would
   * reset on every restart). Actual cadence is driven by comparing "now"
   * against the last VERIFIED backup's verifiedAt, not by this check's own
   * frequency — same design as zulivio's `checkSchedule()`.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkSchedule() {
    const config = await this.getConfig();
    if (!config) return;

    const last = await this.prisma.backup.findFirst({
      where: { status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
    });
    const due =
      !last?.verifiedAt ||
      Date.now() - last.verifiedAt.getTime() >=
        config.intervalDays * 24 * 60 * 60 * 1000;
    if (!due) return;

    this.logger.log(
      `Backup interval elapsed (${config.intervalDays}d) — starting scheduled backup`,
    );
    try {
      await this.runBackup(config, null);
    } catch (err) {
      this.logger.error(`Scheduled backup failed: ${(err as Error).message}`);
    }
  }

  private async runBackup(
    config: EffectiveConfig,
    triggeredById: string | null,
  ) {
    const record = await this.prisma.backup.create({
      data: { triggeredById, status: 'PENDING' },
    });
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'orderrestro-backup-'),
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dbDumpPath = path.join(workDir, 'db.dump');
    const uploadsArchivePath = path.join(workDir, 'uploads.tar.gz');
    const uploadRoot = uploadsDir();

    if (triggeredById) {
      await this.audit.record({
        userId: triggeredById,
        action: 'backup.triggered',
        entity: 'Backup',
        entityId: record.id,
      });
    }

    try {
      // Custom format: compressed single file, restorable with
      // `pg_restore --clean --if-exists` for a clean overwrite on restore.
      await execFileAsync('pg_dump', [
        '--format=custom',
        '--file',
        dbDumpPath,
        process.env.DATABASE_URL!,
      ]);

      const uploadsExist = fsSync.existsSync(uploadRoot);
      if (uploadsExist) {
        await execFileAsync('tar', [
          '-czf',
          uploadsArchivePath,
          '-C',
          path.dirname(uploadRoot),
          path.basename(uploadRoot),
        ]);
      }

      const s3 = this.s3Client(config);
      const dbKey = `${timestamp}/db.dump`;
      const dbBuffer = await fs.readFile(dbDumpPath);
      const sha256 = sha256Hex(dbBuffer);
      const checksums: Record<string, string> = { [DB_FILE]: sha256 };
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: dbKey,
          Body: dbBuffer,
        }),
      );

      let uploadsKey: string | undefined;
      let totalSize = dbBuffer.length;
      if (uploadsExist) {
        uploadsKey = `${timestamp}/${UPLOADS_FILE}`;
        const uploadsBuffer = await fs.readFile(uploadsArchivePath);
        checksums[UPLOADS_FILE] = sha256Hex(uploadsBuffer);
        await s3.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: uploadsKey,
            Body: uploadsBuffer,
          }),
        );
        totalSize += uploadsBuffer.length;
      }
      // SHA256SUMS beside the objects: checked again on every restore and
      // download (backup-integrity.ts), and by `sha256sum -c` by hand.
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: checksumKeyFor(dbKey),
          Body: Buffer.from(formatChecksums(checksums)),
          ContentType: 'text/plain',
        }),
      );

      // Verify by downloading each object back and comparing its sha256
      // against the local file — a real integrity check, and deliberately
      // not HeadObjectCommand: some S3-compatible servers (RustFS) return
      // spurious 403s on HEAD for objects that GET fetches correctly, so
      // HEAD-based verification is not reliable across implementations
      // (same workaround zulivio's backup.service.ts carries, around its
      // line 258).
      // fetchVerifiedObjects re-reads SHA256SUMS too, so this also proves
      // the checksum file itself landed intact.
      await fetchVerifiedObjects(s3, config.bucket, {
        s3KeyDb: dbKey,
        s3KeyUploads: uploadsKey ?? null,
        sha256,
      });

      const completed = await this.prisma.backup.update({
        where: { id: record.id },
        data: {
          status: 'VERIFIED',
          s3KeyDb: dbKey,
          s3KeyUploads: uploadsKey,
          sizeBytes: totalSize,
          sha256,
          verifiedAt: new Date(),
        },
      });

      await this.enforceRetention(config);
      await this.notifyOwners({
        type: 'backup.completed',
        title: 'Backup completed',
        body: `A new backup finished and was verified (${(totalSize / (1024 * 1024)).toFixed(1)} MB).`,
        entity: 'Backup',
        entityId: record.id,
      });
      return completed;
    } catch (err) {
      const failureReason = (err as Error).message;
      await this.prisma.backup.update({
        where: { id: record.id },
        data: { status: 'FAILED', failureReason },
      });
      await this.notifyOwners({
        type: 'backup.failed',
        title: 'Backup failed',
        body: failureReason,
        entity: 'Backup',
        entityId: record.id,
      });
      throw err;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Keeps the most recent `retainCount` VERIFIED backups and deletes older
   * ones, always oldest-first, so a verified backup exists in S3 at every
   * point in time — never a window with zero backups.
   */
  private async enforceRetention(config: EffectiveConfig) {
    const verified = await this.prisma.backup.findMany({
      where: { status: 'VERIFIED' },
      orderBy: { verifiedAt: 'desc' },
    });
    const stale = verified.slice(config.retainCount);
    if (stale.length === 0) return;

    const s3 = this.s3Client(config);
    for (const old of stale) {
      try {
        if (old.s3KeyDb) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: old.s3KeyDb,
            }),
          );
        }
        if (old.s3KeyUploads) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: old.s3KeyUploads,
            }),
          );
        }
        if (old.s3KeyDb) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: config.bucket,
              Key: checksumKeyFor(old.s3KeyDb),
            }),
          );
        }
        await this.prisma.backup.delete({ where: { id: old.id } });
      } catch (err) {
        this.logger.error(
          `Failed to delete stale backup ${old.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Streams a single zip (`db.dump` + `uploads.tar.gz`, whichever exist)
   * fetched server-side from S3 — new beyond zulivio, which never built a
   * local-download path. Audited as `backup.downloaded` since a full data
   * export leaving the server is sensitive in its own right, even without
   * the destructive consequences a restore carries.
   */
  async prepareDownload(user: SessionUser, id: string) {
    const record = await this.prisma.backup.findFirst({ where: { id } });
    if (!record || record.status !== 'VERIFIED' || !record.s3KeyDb) {
      throw new BadRequestException(
        'Backup not found or not in a downloadable (VERIFIED) state',
      );
    }
    const config = await this.requireConfig();
    // Verified before anything is sent: a corrupt backup is reported as
    // such instead of handing the owner a broken file.
    const objects = await fetchVerifiedObjects(
      this.s3Client(config),
      config.bucket,
      record,
    );

    await this.audit.record({
      userId: user.id,
      action: 'backup.downloaded',
      entity: 'Backup',
      entityId: record.id,
    });

    return { record, objects };
  }

  /**
   * Builds a fresh backup (`db.dump` + `uploads.tar.gz`) on local disk for
   * the caller to download straight to their own computer — no S3 bucket
   * needed, with a SHA256SUMS file alongside. Unlike `prepareDownload`
   * nothing is stored on the server or
   * recorded as a Backup row; the caller must `fs.rm(workDir)` when done.
   * Audited as `backup.exported`, same sensitivity as a bucket download.
   */
  async prepareLocalExport(user: SessionUser) {
    await this.audit.record({
      userId: user.id,
      action: 'backup.exported',
      entity: 'Backup',
      entityId: 'local',
    });
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'orderrestro-export-'),
    );
    try {
      const dbDumpPath = path.join(workDir, 'db.dump');
      await execFileAsync('pg_dump', [
        '--format=custom',
        '--file',
        dbDumpPath,
        process.env.DATABASE_URL!,
      ]);
      const uploadRoot = uploadsDir();
      let uploadsArchivePath: string | null = null;
      if (fsSync.existsSync(uploadRoot)) {
        uploadsArchivePath = path.join(workDir, UPLOADS_FILE);
        await execFileAsync('tar', [
          '-czf',
          uploadsArchivePath,
          '-C',
          path.dirname(uploadRoot),
          path.basename(uploadRoot),
        ]);
      }
      const sums: Record<string, string> = {
        [DB_FILE]: sha256Hex(await fs.readFile(dbDumpPath)),
      };
      if (uploadsArchivePath) {
        sums[UPLOADS_FILE] = sha256Hex(await fs.readFile(uploadsArchivePath));
      }
      const checksumsPath = path.join(workDir, CHECKSUM_FILE);
      await fs.writeFile(checksumsPath, formatChecksums(sums));
      return { workDir, dbDumpPath, uploadsArchivePath, checksumsPath };
    } catch (err) {
      await fs.rm(workDir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Destructive: drops and recreates the entire Postgres instance from the
   * backup, then replaces the uploads volume. Gated to the Owner role
   * (checked twice — the controller's `@Auth('backup.manage')` guard, and
   * `requireOwner()` above as an explicit re-check — see its comment for
   * why) plus the literal `confirm: "RESTORE"` string, and only VERIFIED
   * backups are restorable. Audited both BEFORE starting (so there is a
   * record even if the process crashes mid-restore) and after
   * completion/failure, and the Owner is notified at both points too, per
   * the plan's Phase 4 addition.
   */
  async restore(user: SessionUser, id: string, dto: RestoreBackupDto) {
    this.requireOwner(user);
    if (dto.confirm !== 'RESTORE') {
      throw new BadRequestException(
        'This is destructive. Pass confirm: "RESTORE" to proceed.',
      );
    }

    const config = await this.requireConfig();
    const record = await this.prisma.backup.findFirst({
      where: { id, status: 'VERIFIED' },
    });
    if (!record?.s3KeyDb) {
      throw new BadRequestException(
        'Backup not found or not in a restorable (VERIFIED) state',
      );
    }

    const startedAt = new Date().toISOString();
    await this.audit.record({
      userId: user.id,
      action: 'backup.restore_started',
      entity: 'Backup',
      entityId: record.id,
      metadata: { backupId: record.id, startedAt },
    });
    await this.notifyOwners({
      type: 'backup.restore_started',
      title: 'Restore started',
      body: `${user.name} started restoring the database from a backup taken ${record.createdAt.toISOString()}. The app may be briefly unavailable.`,
      entity: 'Backup',
      entityId: record.id,
    });

    const s3 = this.s3Client(config);
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'orderrestro-restore-'),
    );
    const dbDumpPath = path.join(workDir, 'db.dump');
    const uploadsArchivePath = path.join(workDir, 'uploads.tar.gz');
    const uploadRoot = uploadsDir();

    try {
      // Every object is downloaded and checksum-verified BEFORE anything
      // destructive runs; a mismatch throws here and pg_restore never runs.
      const objects = await fetchVerifiedObjects(s3, config.bucket, record);
      await fs.writeFile(dbDumpPath, objects.db);
      // Vet + extract the uploads archive into a scratch dir BEFORE anything
      // destructive: a malicious archive (links, `..`, absolute paths, extra
      // roots) is refused here and surfaces as a 400 with pg_restore untouched.
      let extractedRoot: string | null = null;
      if (objects.uploads) {
        await fs.writeFile(uploadsArchivePath, objects.uploads);
        try {
          extractedRoot = await extractVettedTarball({
            archivePath: uploadsArchivePath,
            expectedRoot: path.basename(uploadRoot),
            destDir: path.join(workDir, 'uploads-extract'),
          });
        } catch (err) {
          if (err instanceof UnsafeArchiveError) {
            throw new BadRequestException(err.message);
          }
          throw err;
        }
      }
      await execFileAsync('pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--dbname',
        process.env.DATABASE_URL!,
        dbDumpPath,
      ]);

      if (extractedRoot) {
        // Empty uploadRoot's contents rather than removing the directory
        // itself: the container's non-root user owns everything inside it
        // but not necessarily its parent, so an rmdir/mkdir round-trip on
        // uploadRoot itself can fail with EACCES. tar then recreates the
        // same tree from the archive, merging into the now-empty
        // directory (same approach zulivio's restore() uses).
        const existingEntries = await fs.readdir(uploadRoot).catch(() => []);
        await Promise.all(
          existingEntries.map((entry) =>
            fs.rm(path.join(uploadRoot, entry), {
              recursive: true,
              force: true,
            }),
          ),
        );
        await fs.cp(extractedRoot, uploadRoot, { recursive: true });
      }

      const completedAt = new Date().toISOString();
      await this.audit.record({
        userId: user.id,
        action: 'backup.restored',
        entity: 'Backup',
        entityId: record.id,
        metadata: { backupId: record.id, startedAt, completedAt },
      });
      await this.notifyOwners({
        type: 'backup.restored',
        title: 'Restore completed',
        body: `Database and uploads were restored from the backup taken ${record.createdAt.toISOString()}.`,
        entity: 'Backup',
        entityId: record.id,
      });

      return { ok: true, restoredFrom: record.id };
    } catch (err) {
      const failureReason = (err as Error).message;
      await this.audit.record({
        userId: user.id,
        action: 'backup.restore_failed',
        entity: 'Backup',
        entityId: record.id,
        metadata: { backupId: record.id, startedAt, error: failureReason },
      });
      await this.notifyOwners({
        type: 'backup.restore_failed',
        title: 'Restore failed',
        body: failureReason,
        entity: 'Backup',
        entityId: record.id,
      });
      throw err;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  private notifyOwners(payload: NotifyPayload) {
    return notifyOwners(this.prisma, this.notifications, payload);
  }
}
