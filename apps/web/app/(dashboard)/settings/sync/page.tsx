"use client";

import { useI18n } from "@/lib/i18n/context";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDisableSync,
  useEnableSync,
  useSyncNow,
  useSyncStatus,
  useTestSync,
} from "@/hooks/use-sync";
import { ApiError } from "@/lib/api";

const SYNC_KEY_SETTING = "SYNC_API_KEY";
const SERVER_URL_EXAMPLE = "https://orders.example.com";

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export default function SyncSettingsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useSyncStatus();
  const test = useTestSync();
  const enable = useEnableSync();
  const syncNow = useSyncNow();
  const disable = useDisableSync();
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState<"adopt" | "merge">("adopt");

  const conn = { serverUrl: serverUrl.trim(), apiKey: apiKey.trim() };

  const connect = () => {
    if (
      mode === "adopt" &&
      !window.confirm(
        t("settings.sync.confirmAdopt"),
      )
    )
      return;
    enable.mutate(
      { ...conn, mode },
      {
        onSuccess: () => {
          toast.success(t("settings.sync.connectedToast"));
          setApiKey("");
        },
        onError: (e) => toast.error(errMsg(e, t("settings.sync.connectFailed"))),
      },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabs />

      <Card className="flex flex-col gap-4 p-6">
        <div>
          <h2 className="text-base font-medium">{t("settings.sync.heading")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.sync.intro")}
          </p>
        </div>

        {isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : data.role === "server" ? (
          <p className="text-sm text-muted-foreground">
            {(() => {
              const [before, after] = t("settings.sync.serverNote", { setting: "\u0000" }).split("\u0000");
              return (
                <>
                  {before}
                  <code>{SYNC_KEY_SETTING}</code>
                  {after}
                </>
              );
            })()}
          </p>
        ) : data.enabled ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={data.lastError ? "destructive" : "secondary"}>
                {data.lastError ? t("settings.sync.notConnected") : t("settings.sync.connected")}
              </Badge>
              <span className="text-muted-foreground">{data.serverUrl}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("settings.sync.lastSynced", {
                when: data.lastSyncAt ? new Date(data.lastSyncAt).toLocaleString() : t("settings.sync.never"),
                pending: data.pendingChanges,
              })}
            </p>
            {data.lastError && <p className="text-sm text-destructive">{data.lastError}</p>}
            {data.conflicts.length > 0 && (
              <details className="text-sm">
                <summary>{t("settings.sync.conflicts", { count: data.conflicts.length })}</summary>
                <ul className="mt-2 list-disc pl-5 text-muted-foreground">
                  {data.conflicts.slice(0, 10).map((c, i) => (
                    <li key={i}>
                      {c.tbl}: {c.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={syncNow.isPending}
                onClick={() =>
                  syncNow.mutate(undefined, {
                    onSuccess: (r) => toast.success(t("settings.sync.synced", { pulled: r.pulled, pushed: r.pushed })),
                    onError: (e) => toast.error(errMsg(e, t("settings.sync.syncFailed"))),
                  })
                }
              >
                {syncNow.isPending ? t("settings.sync.syncing") : t("settings.sync.syncNow")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disable.isPending}
                onClick={() => disable.mutate(undefined, { onSuccess: () => toast.success(t("settings.sync.turnedOff")) })}
              >
                {t("settings.sync.turnOff")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex max-w-xl flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-url">{t("settings.sync.serverAddress")}</Label>
              <Input
                id="sync-url"
                placeholder={SERVER_URL_EXAMPLE}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-key">{t("settings.sync.syncKey")}</Label>
              <Input
                id="sync-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1 font-medium">{t("settings.sync.firstSync")}</legend>
              <label className="flex items-start gap-2">
                <input type="radio" checked={mode === "adopt"} onChange={() => setMode("adopt")} />
                <span>
                  {t("settings.sync.useServerData")}
                  <span className="block text-muted-foreground">
                    {t("settings.sync.useServerDataHint")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} />
                <span>
                  {t("settings.sync.mergeBoth")}
                  <span className="block text-muted-foreground">
                    {t("settings.sync.mergeBothHint")}
                  </span>
                </span>
              </label>
            </fieldset>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!conn.serverUrl || !conn.apiKey || test.isPending}
                onClick={() =>
                  test.mutate(conn, {
                    onSuccess: () => toast.success(t("settings.sync.reachable")),
                    onError: (e) => toast.error(errMsg(e, t("settings.sync.unreachable"))),
                  })
                }
              >
                {test.isPending ? t("settings.sync.testing") : t("settings.sync.test")}
              </Button>
              <Button
                size="sm"
                disabled={!conn.serverUrl || !conn.apiKey || enable.isPending}
                onClick={connect}
              >
                {enable.isPending ? t("settings.sync.connecting") : t("settings.sync.connect")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
