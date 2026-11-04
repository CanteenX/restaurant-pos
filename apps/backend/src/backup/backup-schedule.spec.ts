import * as path from 'node:path';
import {
  backupFolderName,
  isBackupDue,
  isBackupFolderName,
  nextRunAt,
  resolveBackupDir,
  selectForDeletion,
  shouldNotifyFailure,
} from './backup-schedule';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-03T12:00:00.000Z');

describe('isBackupDue / nextRunAt', () => {
  it('is due when there has never been a successful backup', () => {
    expect(isBackupDue(null, 24, now)).toBe(true);
    expect(nextRunAt(null, 24, now)).toEqual(now);
  });

  it('is not due inside the interval and due once it has elapsed', () => {
    const recent = new Date(now.getTime() - 23 * HOUR);
    expect(isBackupDue(recent, 24, now)).toBe(false);
    expect(nextRunAt(recent, 24, now)).toEqual(
      new Date(recent.getTime() + 24 * HOUR),
    );
    const old = new Date(now.getTime() - 24 * HOUR);
    expect(isBackupDue(old, 24, now)).toBe(true);
  });

  it('honours a custom interval', () => {
    const last = new Date(now.getTime() - 7 * HOUR);
    expect(isBackupDue(last, 6, now)).toBe(true);
    expect(isBackupDue(last, 8, now)).toBe(false);
  });
});

describe('backup folder names', () => {
  it('are filesystem-safe, sortable and recognised', () => {
    const name = backupFolderName(now);
    expect(name).toBe('nventra-backup-2026-11-03T12-00-00-000Z');
    expect(name).not.toMatch(/[:.]/);
    expect(isBackupFolderName(name)).toBe(true);
    expect(backupFolderName(new Date(now.getTime() + 1)) > name).toBe(true);
  });

  it('ignores partial writes and unrelated folders', () => {
    expect(isBackupFolderName(`.partial-${backupFolderName(now)}`)).toBe(false);
    expect(isBackupFolderName('photos')).toBe(false);
    expect(isBackupFolderName('nventra-backup-../../etc')).toBe(false);
  });
});

describe('selectForDeletion (retention)', () => {
  const names = [0, 1, 2, 3, 4].map((d) =>
    backupFolderName(new Date(now.getTime() - d * 24 * HOUR)),
  );

  it('keeps the newest N backups and deletes the rest', () => {
    const shuffled = [names[2], names[0], names[4], names[1], names[3]];
    expect(selectForDeletion(shuffled, 3).sort()).toEqual(
      [names[3], names[4]].sort(),
    );
  });

  it('deletes nothing when under the retention count', () => {
    expect(selectForDeletion(names, 5)).toEqual([]);
    expect(selectForDeletion(names, 10)).toEqual([]);
  });

  it('never deletes folders that are not backups', () => {
    expect(selectForDeletion([...names, 'photos', '.partial-x'], 1)).toEqual(
      expect.not.arrayContaining(['photos', '.partial-x']),
    );
    expect(selectForDeletion([...names, 'photos'], 1)).toHaveLength(4);
  });

  it('always keeps at least one backup', () => {
    expect(selectForDeletion(names, 0)).toHaveLength(4);
  });
});

describe('resolveBackupDir (path validation)', () => {
  const root = '/backups';

  it('defaults to the root itself', () => {
    expect(resolveBackupDir(root, undefined)).toBe(path.resolve(root));
    expect(resolveBackupDir(root, '')).toBe(path.resolve(root));
  });

  it('accepts sub-folders, relative or absolute, inside the root', () => {
    expect(resolveBackupDir(root, 'usb/nightly')).toBe(
      path.resolve('/backups/usb/nightly'),
    );
    expect(resolveBackupDir(root, '/backups/nas')).toBe(path.resolve('/backups/nas'));
  });

  it.each([
    '../etc',
    'usb/../../etc',
    '/etc',
    '/backups-evil',
    '/backups/../root',
    'usb\0x',
  ])('rejects %p (traversal / outside the allowed root)', (dir) => {
    expect(() => resolveBackupDir(root, dir)).toThrow(
      /inside the allowed backup root/,
    );
  });

  it('rejects when no allowed root is configured', () => {
    expect(() => resolveBackupDir('', 'x')).toThrow(/LOCAL_BACKUP_ROOT/);
    expect(() => resolveBackupDir('relative/root', 'x')).toThrow(
      /LOCAL_BACKUP_ROOT/,
    );
  });
});

describe('shouldNotifyFailure', () => {
  const earlier = new Date(now.getTime() - 5 * HOUR);
  const later = new Date(now.getTime() - 1 * HOUR);

  it('notifies on the first failure after a success (or ever)', () => {
    expect(shouldNotifyFailure(null, null)).toBe(true);
    expect(shouldNotifyFailure(later, earlier)).toBe(true);
  });

  it('does not repeat while it is still failing', () => {
    expect(shouldNotifyFailure(earlier, later)).toBe(false);
    expect(shouldNotifyFailure(null, later)).toBe(false);
  });
});
