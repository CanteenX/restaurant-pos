import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';

/**
 * Pure scheduling, retention and path rules for local (folder / USB / NAS)
 * backups. No I/O here, so every rule is unit-tested in
 * backup-schedule.spec.ts; LocalBackupService does the filesystem work.
 */

const HOUR_MS = 60 * 60 * 1000;
const PREFIX = 'nventra-backup-';
const NAME_RE = /^nventra-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Due when there has never been a success, or the interval has elapsed. */
export function isBackupDue(
  lastSuccessAt: Date | null,
  intervalHours: number,
  now: Date,
): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() >= intervalHours * HOUR_MS;
}

export function nextRunAt(
  lastSuccessAt: Date | null,
  intervalHours: number,
  now: Date,
): Date {
  if (!lastSuccessAt) return now;
  return new Date(lastSuccessAt.getTime() + intervalHours * HOUR_MS);
}

/** `nventra-backup-2026-11-03T12-00-00-000Z`: no `:` (FAT/exFAT USB sticks). */
export function backupFolderName(at: Date): string {
  return PREFIX + at.toISOString().replace(/[:.]/g, '-');
}

export function isBackupFolderName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Names to delete so only the newest `retainCount` backups remain. Names
 * sort chronologically, folders that are not backups are never touched, and
 * at least one backup is always kept.
 */
export function selectForDeletion(
  names: string[],
  retainCount: number,
): string[] {
  const keep = Math.max(1, Math.floor(retainCount));
  const backups = names.filter(isBackupFolderName).sort().reverse();
  return backups.slice(keep);
}

/**
 * Resolves the configured backup directory against the allowed root
 * (`LOCAL_BACKUP_ROOT`, the container mount point). Lexical check only;
 * LocalBackupService re-checks with realpath so a symlink cannot escape.
 */
export function resolveBackupDir(
  root: string,
  requested: string | null | undefined,
): string {
  if (!root || !path.isAbsolute(root)) {
    throw new BadRequestException(
      'Local backups are not enabled: set LOCAL_BACKUP_ROOT to an absolute path (the folder mounted into the backend container).',
    );
  }
  const base = path.resolve(root);
  const dir = requested?.trim() ?? '';
  if (dir.includes('\0')) throw outsideRoot(base);
  const resolved = path.resolve(base, dir);
  if (!isInside(base, resolved)) throw outsideRoot(base);
  return resolved;
}

export function isInside(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function outsideRoot(base: string) {
  return new BadRequestException(
    `Backup directory must be inside the allowed backup root (${base}).`,
  );
}

/**
 * Notify on the first failure after a success (or the first run ever), not
 * on every hourly retry while the disk stays unplugged. Status keeps
 * showing the failure in the meantime.
 */
export function shouldNotifyFailure(
  lastSuccessAt: Date | null,
  lastFailureAt: Date | null,
): boolean {
  if (!lastFailureAt) return true;
  return !!lastSuccessAt && lastSuccessAt > lastFailureAt;
}
