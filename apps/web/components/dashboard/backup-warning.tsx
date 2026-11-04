"use client";

import { DatabaseBackup } from "lucide-react";
import Link from "next/link";
import { hasPermission, useCurrentUser } from "@/hooks/use-auth";
import { useBackups, useLocalBackupStatus } from "@/hooks/use-backups";
import { backupWarning } from "@/lib/backup-status";

const MESSAGES = {
  none: "No good backup yet. Set up backups so your data is safe.",
  stale: "Your last good backup is more than 48 hours old.",
  failed: "The latest backup failed.",
} as const;

/** Owner-only banner: shown when backups are stale, missing or failing. */
export function BackupWarning() {
  const { data: me } = useCurrentUser();
  const can = hasPermission(me?.user, "backup.manage");
  const { data: backups, isLoading: l1 } = useBackups(can);
  const { data: local, isLoading: l2 } = useLocalBackupStatus(can);
  if (!can || l1 || l2) return null;

  const warning = backupWarning(
    {
      backups,
      localLastSuccessAt: local?.lastSuccessAt,
      localLastFailureAt: local?.lastFailureAt,
    },
    new Date(),
  );
  if (!warning) return null;

  return (
    <div
      role="alert"
      data-testid="backup-warning"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <DatabaseBackup className="h-5 w-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{MESSAGES[warning.kind]}</p>
        <p className="text-muted-foreground">
          {warning.lastGoodAt
            ? `Last good backup: ${new Date(warning.lastGoodAt).toLocaleString()}`
            : "No successful backup recorded."}
        </p>
      </div>
      <Link href="/settings/backup" className="font-medium text-primary underline-offset-2 hover:underline">
        Open backup settings
      </Link>
    </div>
  );
}
