"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";
import { RestoreBackupDialog } from "@/components/settings/restore-backup-dialog";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  backupDownloadUrl,
  LOCAL_BACKUP_URL,
  useBackups,
  useBackupStatus,
  useClearBackupConfig,
  useSetBackupConfig,
  useTriggerBackup,
  type BackupEntry,
  type BackupStatusValue,
} from "@/hooks/use-backups";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const STATUS_VARIANT: Record<BackupStatusValue, "outline" | "secondary" | "destructive"> = {
  PENDING: "outline",
  VERIFIED: "secondary",
  FAILED: "destructive",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ConfigFormState {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  intervalDays: string;
  retainCount: string;
}

const EMPTY_CONFIG_FORM: ConfigFormState = {
  endpoint: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  region: "auto",
  intervalDays: "3",
  retainCount: "2",
};

export default function BackupPage() {
  const { t } = useI18n();
  const { data: status, isLoading: statusLoading } = useBackupStatus();
  const { data: backups, isLoading: backupsLoading } = useBackups();
  const setConfig = useSetBackupConfig();
  const clearConfig = useClearBackupConfig();
  const triggerBackup = useTriggerBackup();

  const [showConfigForm, setShowConfigForm] = useState(false);
  const [configForm, setConfigForm] = useState<ConfigFormState>(EMPTY_CONFIG_FORM);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);

  const openConfigForm = () => {
    setConfigForm(
      status
        ? {
            endpoint: status.endpoint ?? "",
            bucket: status.bucket ?? "",
            accessKeyId: "",
            secretAccessKey: "",
            region: status.region ?? "auto",
            intervalDays: String(status.intervalDays),
            retainCount: String(status.retainCount),
          }
        : EMPTY_CONFIG_FORM,
    );
    setShowConfigForm(true);
  };

  const onSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    setConfig.mutate(
      {
        endpoint: configForm.endpoint.trim(),
        bucket: configForm.bucket.trim(),
        accessKeyId: configForm.accessKeyId.trim(),
        secretAccessKey: configForm.secretAccessKey.trim(),
        region: configForm.region.trim() || undefined,
        intervalDays: Number(configForm.intervalDays) || undefined,
        retainCount: Number(configForm.retainCount) || undefined,
      },
      {
        onSuccess: () => {
          toast.success(t("settings.backup.connectionSaved"));
          setShowConfigForm(false);
        },
        onError: (err) =>
          toast.error(
            err instanceof ApiError ? err.message : t("settings.backup.connectFailed"),
          ),
      },
    );
  };

  const onDisconnect = () => {
    if (!confirm(t("settings.backup.disconnectConfirm"))) {
      return;
    }
    clearConfig.mutate(undefined, {
      onSuccess: () => toast.success(t("settings.backup.connectionRemoved")),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : t("settings.backup.disconnectFailed")),
    });
  };

  const onTrigger = () => {
    triggerBackup.mutate(undefined, {
      onSuccess: () => toast.success(t("settings.backup.started")),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : t("settings.backup.startFailed")),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.backup.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.backup.subtitle")}</p>
      </div>

      <SettingsTabs />

      <Card className="flex flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-medium text-foreground">{t("settings.backup.download.title")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.backup.download.desc")}
            </p>
          </div>
          <Button render={<a href={LOCAL_BACKUP_URL} download />}>{t("settings.backup.download.now")}</Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-medium text-foreground">{t("settings.backup.s3.title")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.backup.s3.desc")}
            </p>
          </div>
          {status ? (
            <Badge variant={status.configured ? "secondary" : "outline"}>
              {status.configured ? t("settings.backup.configured") : t("settings.backup.notConfigured")}
            </Badge>
          ) : null}
        </div>

        {statusLoading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : !status?.configured || showConfigForm ? (
          <form onSubmit={onSaveConfig} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t("settings.backup.connect.help")}
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="b-endpoint">{t("settings.backup.endpoint")}</Label>
                <Input
                  id="b-endpoint"
                  placeholder={t("settings.backup.endpointPlaceholder")}
                  value={configForm.endpoint}
                  onChange={(e) => setConfigForm((f) => ({ ...f, endpoint: e.target.value }))}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="b-bucket">{t("settings.backup.bucket")}</Label>
                <Input
                  id="b-bucket"
                  value={configForm.bucket}
                  onChange={(e) => setConfigForm((f) => ({ ...f, bucket: e.target.value }))}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="b-key">{t("settings.backup.accessKey")}</Label>
                <Input
                  id="b-key"
                  value={configForm.accessKeyId}
                  onChange={(e) => setConfigForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="b-secret">{t("settings.backup.secretKey")}</Label>
                <Input
                  id="b-secret"
                  type="password"
                  value={configForm.secretAccessKey}
                  onChange={(e) =>
                    setConfigForm((f) => ({ ...f, secretAccessKey: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="b-region">{t("settings.backup.region")}</Label>
                <Input
                  id="b-region"
                  placeholder={t("settings.backup.regionPlaceholder")}
                  value={configForm.region}
                  onChange={(e) => setConfigForm((f) => ({ ...f, region: e.target.value }))}
                />
              </div>
              <div className="flex gap-4">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="b-interval">{t("settings.backup.interval")}</Label>
                  <Input
                    id="b-interval"
                    type="number"
                    min={1}
                    max={30}
                    value={configForm.intervalDays}
                    onChange={(e) =>
                      setConfigForm((f) => ({ ...f, intervalDays: e.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="b-retain">{t("settings.backup.retain")}</Label>
                  <Input
                    id="b-retain"
                    type="number"
                    min={1}
                    max={10}
                    value={configForm.retainCount}
                    onChange={(e) =>
                      setConfigForm((f) => ({ ...f, retainCount: e.target.value }))
                    }
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={setConfig.isPending}>
                {setConfig.isPending ? t("settings.backup.testing") : t("settings.backup.connectSave")}
              </Button>
              {status?.configured ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowConfigForm(false)}
                >
                  {t("settings.backup.cancel")}
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <div>
                <p className="text-foreground">
                  {status.bucket}{" "}
                  <span className="text-muted-foreground">{t("settings.backup.at", { endpoint: status.endpoint ?? "" })}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.backup.keyLine", {
                    key: status.accessKeyIdMasked ?? "",
                    source:
                      status.source === "environment"
                        ? t("settings.backup.source.env")
                        : t("settings.backup.source.here"),
                  })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={openConfigForm}>
                  {t("settings.backup.change")}
                </Button>
                {status.source === "database" ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={clearConfig.isPending}
                    onClick={onDisconnect}
                  >
                    {t("settings.backup.disconnect")}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label={t("settings.backup.runsEvery")} value={t("settings.backup.runsEveryValue", { count: status.intervalDays })} />
              <Stat label={t("settings.backup.keeps")} value={t("settings.backup.keepsValue", { count: status.retainCount })} />
              <Stat
                label={t("settings.backup.lastBackup")}
                value={
                  status.lastBackup
                    ? new Date(status.lastBackup.createdAt).toLocaleString()
                    : t("settings.backup.never")
                }
              />
              <Stat
                label={t("settings.backup.nextScheduled")}
                value={
                  status.nextScheduledAt
                    ? new Date(status.nextScheduledAt).toLocaleString()
                    : "—"
                }
              />
            </div>

            <div>
              <Button onClick={onTrigger} disabled={triggerBackup.isPending}>
                {triggerBackup.isPending ? t("settings.backup.starting") : t("settings.backup.backUpNow")}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="text-[18px] font-medium text-foreground">{t("settings.backup.history.title")}</h2>

        {backupsLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : backups && backups.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.backup.col.started")}</TableHead>
                <TableHead>{t("settings.backup.col.status")}</TableHead>
                <TableHead>{t("settings.backup.col.size")}</TableHead>
                <TableHead className="text-right">{t("settings.backup.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium text-foreground">
                    {new Date(b.createdAt).toLocaleString()}
                    <div className="text-xs font-normal text-muted-foreground">
                      {b.triggeredById ? t("settings.backup.manual") : t("settings.backup.scheduled")}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[b.status]}>{b.status}</Badge>
                    {b.status === "FAILED" && b.failureReason ? (
                      <div className="mt-1 max-w-xs truncate text-xs text-destructive" title={b.failureReason}>
                        {b.failureReason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatBytes(b.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {b.status === "VERIFIED" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          render={<a href={backupDownloadUrl(b.id)} />}
                        >
                          {t("settings.backup.download")}
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" disabled>
                          {t("settings.backup.download")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={b.status !== "VERIFIED"}
                        onClick={() => setRestoreTarget(b)}
                      >
                        {t("settings.backup.restore")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("settings.backup.empty.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("settings.backup.empty.desc")}
            </p>
          </div>
        )}
      </Card>

      {restoreTarget ? (
        <RestoreBackupDialog
          key={restoreTarget.id}
          backup={restoreTarget}
          onClose={() => setRestoreTarget(null)}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
