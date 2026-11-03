import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { SessionUser, SetLocalBackupConfigDto } from '@nventra/types';
import { AuditService } from '../audit/audit.service';
import { uploadsDir } from '../common/upload/image-upload.config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHECKSUM_FILE,
  DB_FILE,
  UPLOADS_FILE,
  formatChecksums,
} from './backup-integrity';
import {
  backupFolderName,
  isBackupDue,
  isBackupFolderName,
  isInside,
  nextRunAt,
  resolveBackupDir,
  selectForDeletion,
  shouldNotifyFailure,
} from './backup-schedule';
import { notifyOwners } from './notify-owners';

const execFileAsync = promisify(execFile);
const CONFIG_ID = 'singleton';
const PARTIAL_PREFIX = '.partial-';

interface LocalConfig {
  enabled: boolean;
  root: string;
  directory: string;
  intervalHours: number;
  retainCount: number;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Flushes a file or directory to disk so a power cut can't leave a torn backup. */
async function fsyncPath(p: string): Promise<void> {
  const fh = await fs.open(p, 'r');
  try {
    await fh.sync();
  } catch {
    // Some filesystems (e.g. directories on SMB/NFS mounts) refuse fsync.
  } finally {
    await fh.close();
  }
}

/**
 * Scheduled backups (Postgres dump + uploads + SHA256SUMS) to a folder the
 * owner mounts into the backend container — a USB drive or NAS share — so a
 * dead server disk does not take the only copy with it (issue #29).
 *
 * Config: the DB row (Settings) overrides LOCAL_BACKUP_* env vars, but the
 * allowed root is env-only (LOCAL_BACKUP_ROOT) so nobody can point backups
 * at an arbitrary server path from the app. Each run writes into a
 * `.partial-*` folder, fsyncs, verifies the checksums, then renames it into
 * place, so a backup folder either exists complete or not at all.
 */
@Injectable()
export class LocalBackupService {
  private readonly logger = new Logger(LocalBackupService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private row() {
    return this.prisma.localBackupConfig.findUnique({
      where: { id: CONFIG_ID },
    });
  }

  private async getConfig(): Promise<LocalConfig> {
    const row = await this.row();
    const root = process.env.LOCAL_BACKUP_ROOT?.trim() ?? '';
    return {
      enabled:
        row?.enabled ??
        (!!root && process.env.LOCAL_BACKUP_ENABLED !== 'false'),
      root,
      directory: row?.directory ?? process.env.LOCAL_BACKUP_DIR ?? '',
      intervalHours:
        row?.intervalHours ?? envInt('LOCAL_BACKUP_INTERVAL_HOURS', 24),
      retainCount: row?.retainCount ?? envInt('LOCAL_BACKUP_RETAIN_COUNT', 7),
    };
  }

  /** Resolved dir, re-checked with realpath so a symlink cannot escape the root. */
  private async safeDir(config: LocalConfig): Promise<string> {
    const dir = resolveBackupDir(config.root, config.directory);
    const realRoot = await fs.realpath(config.root).catch(() => {
      throw new Error(
        `Backup root ${config.root} does not exist (is the drive mounted?)`,
      );
    });
    await fs.mkdir(dir, { recursive: true });
    const realDir = await fs.realpath(dir);
    if (!isInside(realRoot, realDir)) {
      throw new BadRequestException(
        `Backup directory must be inside the allowed backup root (${config.root}).`,
      );
    }
    return realDir;
  }

  async status() {
    const [config, row] = await Promise.all([this.getConfig(), this.row()]);
    const lastSuccessAt = row?.lastSuccessAt ?? null;
    let directory: string | null = null;
    let backups: string[] = [];
    try {
      directory = resolveBackupDir(config.root, config.directory);
      const entries = await fs.readdir(directory).catch(() => []);
      backups = entries.filter(isBackupFolderName).sort().reverse();
    } catch {
      directory = null;
    }
    return {
      enabled: config.enabled && !!config.root,
      root: config.root || null,
      directory,
      intervalHours: config.intervalHours,
      retainCount: config.retainCount,
      running: this.running,
      lastSuccessAt,
      lastSuccessPath: row?.lastSuccessPath ?? null,
      lastSizeBytes: row?.lastSizeBytes ?? null,
      lastFailureAt: row?.lastFailureAt ?? null,
      lastFailureReason: row?.lastFailureReason ?? null,
      nextRunAt: config.enabled
        ? nextRunAt(lastSuccessAt, config.intervalHours, new Date())
        : null,
      backups,
    };
  }

  async setConfig(user: SessionUser, dto: SetLocalBackupConfigDto) {
    const current = await this.getConfig();
    const next = { ...current, ...dto };
    // Validates (throws 400) before anything is stored.
    resolveBackupDir(next.root, next.directory);
    const data = {
      enabled: next.enabled,
      directory: next.directory,
      intervalHours: next.intervalHours,
      retainCount: next.retainCount,
      updatedById: user.id,
    };
    await this.prisma.localBackupConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data },
      update: data,
    });
    await this.audit.record({
      userId: user.id,
      action: 'backup.local_config_updated',
      entity: 'LocalBackupConfig',
      metadata: { ...data, updatedById: undefined },
    });
    return this.status();
  }

  async runManual(user: SessionUser) {
    const config = await this.getConfig();
    resolveBackupDir(config.root, config.directory);
    await this.audit.record({
      userId: user.id,
      action: 'backup.local_triggered',
      entity: 'LocalBackupConfig',
    });
    try {
      await this.run(config, true);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new InternalServerErrorException(
        `Local backup failed: ${(err as Error).message}`,
      );
    }
    return this.status();
  }

  /** Hourly check; the cadence comes from lastSuccessAt, so restarts don't reset it. */
  @Cron(CronExpression.EVERY_HOUR)
  async checkSchedule() {
    const config = await this.getConfig();
    if (!config.enabled || !config.root) return;
    const row = await this.row();
    if (
      !isBackupDue(row?.lastSuccessAt ?? null, config.intervalHours, new Date())
    )
      return;
    try {
      await this.run(config, false);
    } catch (err) {
      this.logger.error(
        `Scheduled local backup failed: ${(err as Error).message}`,
      );
    }
  }

  private async run(config: LocalConfig, manual: boolean) {
    if (this.running)
      throw new ConflictException('A backup is already running');
    this.running = true;
    try {
      const result = await this.writeBackup(config);
      await this.recordSuccess(result.finalDir, result.sizeBytes);
      await this.enforceRetention(
        path.dirname(result.finalDir),
        config.retainCount,
      );
      return result;
    } catch (err) {
      await this.recordFailure((err as Error).message, manual);
      throw err;
    } finally {
      this.running = false;
    }
  }

  private async writeBackup(config: LocalConfig) {
    const dir = await this.safeDir(config);
    await this.removePartials(dir);
    const name = backupFolderName(new Date());
    const partial = path.join(dir, PARTIAL_PREFIX + name);
    const finalDir = path.join(dir, name);
    await fs.mkdir(partial);
    try {
      const files = await this.dumpInto(partial);
      const sums: Record<string, string> = {};
      let sizeBytes = 0;
      for (const f of files) {
        const p = path.join(partial, f);
        await fsyncPath(p);
        sums[f] = await sha256File(p);
        sizeBytes += (await fs.stat(p)).size;
      }
      const sumsPath = path.join(partial, CHECKSUM_FILE);
      await fs.writeFile(sumsPath, formatChecksums(sums));
      await fsyncPath(sumsPath);
      await this.verify(partial, sums);
      await fs.rename(partial, finalDir);
      await fsyncPath(dir);
      return { finalDir, sizeBytes, sums };
    } catch (err) {
      await fs.rm(partial, { recursive: true, force: true });
      throw err;
    }
  }

  private async dumpInto(dir: string): Promise<string[]> {
    await execFileAsync('pg_dump', [
      '--format=custom',
      '--file',
      path.join(dir, DB_FILE),
      process.env.DATABASE_URL!,
    ]);
    const uploadRoot = uploadsDir();
    await execFileAsync('tar', [
      '-czf',
      path.join(dir, UPLOADS_FILE),
      '-C',
      path.dirname(uploadRoot),
      path.basename(uploadRoot),
    ]);
    return [DB_FILE, UPLOADS_FILE];
  }

  /** Re-reads what landed on the target disk (it may be a flaky USB stick). */
  private async verify(dir: string, sums: Record<string, string>) {
    for (const [file, expected] of Object.entries(sums)) {
      if ((await sha256File(path.join(dir, file))) !== expected) {
        throw new Error(`Checksum mismatch after writing ${file}`);
      }
    }
  }

  private async removePartials(dir: string) {
    const entries = await fs.readdir(dir);
    for (const e of entries.filter((n) => n.startsWith(PARTIAL_PREFIX))) {
      await fs.rm(path.join(dir, e), { recursive: true, force: true });
    }
  }

  private async enforceRetention(dir: string, retainCount: number) {
    const stale = selectForDeletion(await fs.readdir(dir), retainCount);
    for (const name of stale) {
      await fs
        .rm(path.join(dir, name), { recursive: true, force: true })
        .catch((err: Error) =>
          this.logger.error(
            `Could not delete old backup ${name}: ${err.message}`,
          ),
        );
    }
  }

  private async recordSuccess(finalDir: string, sizeBytes: number) {
    const data = {
      lastSuccessAt: new Date(),
      lastSuccessPath: finalDir,
      lastSizeBytes: Math.min(sizeBytes, 2 ** 31 - 1),
    };
    await this.prisma.localBackupConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data },
      update: data,
    });
  }

  private async recordFailure(reason: string, manual: boolean) {
    const row = await this.row();
    const notify =
      manual ||
      shouldNotifyFailure(
        row?.lastSuccessAt ?? null,
        row?.lastFailureAt ?? null,
      );
    const data = {
      lastFailureAt: new Date(),
      lastFailureReason: reason.slice(0, 1000),
    };
    await this.prisma.localBackupConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ...data },
      update: data,
    });
    if (!notify) return;
    await notifyOwners(this.prisma, this.notifications, {
      type: 'backup.local_failed',
      title: 'Local backup failed',
      body: reason.slice(0, 500),
      entity: 'LocalBackupConfig',
      entityId: CONFIG_ID,
    });
  }
}
