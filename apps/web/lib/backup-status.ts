export const BACKUP_STALE_HOURS = 48;

export interface BackupWarningInput {
  /** S3 backup history, newest first (GET /backups). */
  backups?: { status: "PENDING" | "VERIFIED" | "FAILED"; createdAt: string }[];
  /** Local folder/USB/NAS backup state (GET /backups/local/status). */
  localLastSuccessAt?: string | null;
  localLastFailureAt?: string | null;
}

export interface BackupWarning {
  kind: "none" | "stale" | "failed";
  /** ISO time of the newest good backup across all destinations. */
  lastGoodAt: string | null;
}

const ts = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);

/** Returns a warning when the owner should look at backups, otherwise null. */
export function backupWarning(
  input: BackupWarningInput,
  now: Date,
  staleHours = BACKUP_STALE_HOURS,
): BackupWarning | null {
  const settled = (input.backups ?? []).filter((b) => b.status !== "PENDING");
  const goodS3 = ts(settled.find((b) => b.status === "VERIFIED")?.createdAt);
  const failedS3 = settled[0]?.status === "FAILED" ? ts(settled[0].createdAt) : null;
  const localOk = ts(input.localLastSuccessAt);
  const localFail = ts(input.localLastFailureAt);

  const goods = [goodS3, localOk].filter((t): t is number => t !== null);
  const lastGood = goods.length ? Math.max(...goods) : null;
  const lastGoodAt = lastGood === null ? null : new Date(lastGood).toISOString();

  if (lastGood === null) return { kind: "none", lastGoodAt };
  const failed =
    (failedS3 !== null && failedS3 > (goodS3 ?? 0)) ||
    (localFail !== null && localFail > (localOk ?? 0));
  if (failed) return { kind: "failed", lastGoodAt };
  if (now.getTime() - lastGood > staleHours * 3_600_000) return { kind: "stale", lastGoodAt };
  return null;
}
