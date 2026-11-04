"use client";

import { useI18n, type TranslationKey } from "@/lib/i18n/context";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { NavDot } from "@/components/layout/nav-dot";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useApplyUpdate, useUpdateCheck } from "@/hooks/use-updates";
import { ApiError } from "@/lib/api";

// After "Update now" the updater sidecar pulls the new images (the app keeps
// running meanwhile) and then restarts the backend. Each tick asks the
// backend what the updater is doing: a reported error stops the wait with a
// real message, "done" reloads, and if the backend has gone away (restart in
// progress) the unauthenticated health route decides when it is back.
function pollUntilBackUp(onFailed: VoidFunction, t: (key: TranslationKey, vars?: Record<string, string | number>) => string) {
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let wentDown = false;
  const interval = setInterval(async () => {
    if (Date.now() - start > timeoutMs) {
      clearInterval(interval);
      onFailed();
      toast.error(t("settings.updates.stillDown"));
      return;
    }
    try {
      const res = await fetch("/api/v1/system/update/progress", {
        cache: "no-store",
        credentials: "include",
      });
      if (res.ok) {
        const p = (await res.json()) as { state: string; error?: string | null };
        if (p.state === "error") {
          clearInterval(interval);
          onFailed();
          toast.error(
            t("settings.updates.failed", { error: p.error ?? t("settings.updates.unknownError") }),
          );
          return;
        }
        if (p.state === "done") {
          clearInterval(interval);
          toast.success(t("settings.updates.finished"));
          window.location.reload();
          return;
        }
        return; // pulling / restarting: keep waiting
      }
    } catch {
      // backend is restarting
    }
    wentDown = true;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok && wentDown) {
        clearInterval(interval);
        toast.success(t("settings.updates.finished"));
        window.location.reload();
      }
    } catch {
      // still down
    }
  }, 3000);
}

export default function UpdatesPage() {
  const { t } = useI18n();
  const { data, isLoading, refetch, isFetching } = useUpdateCheck();
  const applyUpdate = useApplyUpdate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);

  const handleUpdate = () => {
    setConfirmOpen(false);
    setApplying(true);
    applyUpdate.mutate(undefined, {
      onSuccess: (result) => {
        toast.info(result.message);
        pollUntilBackUp(() => setApplying(false), t);
      },
      onError: (err) => {
        setApplying(false);
        toast.error(err instanceof ApiError ? err.message : t("settings.updates.startFailed"));
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsTabs />

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium">{t("settings.updates.heading")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.updates.intro")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? t("settings.updates.checking") : t("settings.updates.check")}
          </Button>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : data ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("settings.updates.running")}</span>
              <Badge variant="outline">{data.currentVersion}</Badge>
              {data.latestVersion && (
                <>
                  <span className="text-muted-foreground">{t("settings.updates.latest")}</span>
                  <Badge variant={data.updateAvailable || data.building ? "secondary" : "outline"}>
                    {data.latestVersion}
                  </Badge>
                </>
              )}
              {data.updateAvailable ? (
                <Badge className="gap-2">
                  <NavDot className="ml-0 h-2 w-2" label={t("settings.updates.available")} />
                  {t("settings.updates.available")}
                </Badge>
              ) : data.building ? (
                <Badge variant="outline">{t("settings.updates.building")}</Badge>
              ) : (
                <Badge variant="outline">{t("settings.updates.upToDate")}</Badge>
              )}
            </div>

            {data.currentVersion === "dev" && (
              <p className="text-sm text-muted-foreground">
                {t("settings.updates.devBuild")}
              </p>
            )}

            {data.building && (
              <p className="text-sm text-muted-foreground">
                {t("settings.updates.buildingNote", { version: data.latestVersion ?? "" })}
              </p>
            )}

            {data.releaseUrl && (
              <a
                href={data.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted-foreground underline underline-offset-3 hover:text-foreground"
              >
                {t("settings.updates.releaseNotes")}
              </a>
            )}

            {data.updateAvailable && (
              <Button
                className="self-start"
                disabled={applying}
                onClick={() => setConfirmOpen(true)}
              >
                {applying ? t("settings.updates.updating") : t("settings.updates.updateNow")}
              </Button>
            )}
          </div>
        ) : null}
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.updates.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.updates.confirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("settings.updates.cancel")}</DialogClose>
            <Button onClick={handleUpdate}>{t("settings.updates.updateNow")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
