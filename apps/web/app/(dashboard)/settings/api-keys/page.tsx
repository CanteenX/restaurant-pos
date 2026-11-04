"use client";

import { Fragment, useState, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import { CreateIntegrationKeyDialog } from "@/components/settings/create-integration-key-dialog";
import { CreateStaffKeyDialog } from "@/components/settings/create-staff-key-dialog";
import { NewApiKeyDialog } from "@/components/settings/new-api-key-dialog";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hasPermission, useCurrentUser } from "@/hooks/use-auth";
import {
  useIntegrationApiKeys,
  useRevokeIntegrationApiKey,
  useRotateIntegrationApiKey,
  useRevokeStaffApiKey,
  useStaffApiKeys,
  type IntegrationApiKey,
  type StaffApiKey,
} from "@/hooks/use-api-keys";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

// Inline markup helper for translated strings.
function rich(text: string, tags: Record<string, (children: string) => ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    out.push(<Fragment key={at}>{tags[m[1]]?.(m[2]) ?? m[2]}</Fragment>);
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export default function ApiKeysPage() {
  const { t } = useI18n();
  const { data } = useCurrentUser();
  const user = data?.user;
  const canManageIntegrations = hasPermission(user, "settings.manage");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.apiKeys.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.apiKeys.subtitle")}</p>
      </div>

      <SettingsTabs />

      <StaffApiKeysCard />
      {canManageIntegrations ? <IntegrationApiKeysCard /> : null}
    </div>
  );
}

function StaffApiKeysCard() {
  const { t } = useI18n();
  const { data: keys, isLoading } = useStaffApiKeys();
  const revokeKey = useRevokeStaffApiKey();
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const onRevoke = (key: StaffApiKey) => {
    if (!confirm(t("settings.apiKeys.personal.revokeConfirm", { name: key.name }))) return;
    revokeKey.mutate(key.id, {
      onSuccess: () => toast.success(t("settings.apiKeys.keyRevoked")),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t("settings.apiKeys.revokeFailed")),
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-medium text-foreground">{t("settings.apiKeys.personal.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.apiKeys.personal.desc")}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          {t("settings.apiKeys.newKey")}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("settings.apiKeys.mcp.title")}</p>
        <code className="mt-1 block overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs">
          {typeof window !== "undefined" ? window.location.origin : ""}/api/v1/mcp
        </code>
        <p className="mt-2">
          {rich(t("settings.apiKeys.mcp.help"), {
            code: (text) => <code className="font-mono">{text}</code>,
            docs: (text) => (
              <a href="/docs/api" className="underline">
                {text}
              </a>
            ),
          })}
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : keys && keys.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("settings.apiKeys.col.name")}</TableHead>
              <TableHead>{t("settings.apiKeys.col.key")}</TableHead>
              <TableHead>{t("settings.apiKeys.col.lastUsed")}</TableHead>
              <TableHead className="text-right">{t("settings.apiKeys.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium text-foreground">{key.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">…{key.lastFour}</TableCell>
                <TableCell className="text-muted-foreground">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : t("settings.apiKeys.never")}
                </TableCell>
                <TableCell className="text-right">
                  {key.revokedAt ? (
                    <Badge variant="outline">{t("settings.apiKeys.revoked")}</Badge>
                  ) : (
                    <Button size="sm" variant="destructive" onClick={() => onRevoke(key)}>
                      {t("settings.apiKeys.revoke")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("settings.apiKeys.personal.empty")}</p>
      )}

      {showCreate ? (
        <CreateStaffKeyDialog
          onClose={() => setShowCreate(false)}
          onCreated={(token) => {
            setShowCreate(false);
            setNewToken(token);
          }}
        />
      ) : null}
      {newToken ? <NewApiKeyDialog token={newToken} onClose={() => setNewToken(null)} /> : null}
    </Card>
  );
}

function IntegrationApiKeysCard() {
  const { t } = useI18n();
  const { data: keys, isLoading } = useIntegrationApiKeys();
  const revokeKey = useRevokeIntegrationApiKey();
  const rotateKey = useRotateIntegrationApiKey();
  const [showCreate, setShowCreate] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  const onRotate = (key: IntegrationApiKey) => {
    if (!confirm(t("settings.apiKeys.integration.rotateConfirm", { name: key.name }))) return;
    rotateKey.mutate(key.id, {
      onSuccess: (created) => setNewToken(created.token),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t("settings.apiKeys.integration.rotateFailed")),
    });
  };

  const onRevoke = (key: IntegrationApiKey) => {
    if (!confirm(t("settings.apiKeys.integration.revokeConfirm", { name: key.name }))) return;
    revokeKey.mutate(key.id, {
      onSuccess: () => toast.success(t("settings.apiKeys.keyRevoked")),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : t("settings.apiKeys.revokeFailed")),
    });
  };

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[18px] font-medium text-foreground">{t("settings.apiKeys.integration.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.apiKeys.integration.desc")}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          {t("settings.apiKeys.newKey")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : keys && keys.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("settings.apiKeys.col.name")}</TableHead>
              <TableHead>{t("settings.apiKeys.col.key")}</TableHead>
              <TableHead>{t("settings.apiKeys.col.location")}</TableHead>
              <TableHead>{t("settings.apiKeys.col.permissions")}</TableHead>
              <TableHead className="text-right">{t("settings.apiKeys.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium text-foreground">{key.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">…{key.lastFour}</TableCell>
                <TableCell className="text-muted-foreground">{key.branch?.name ?? t("settings.apiKeys.integration.allLocations")}</TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="flex flex-wrap gap-1">
                    {key.scopes.map((s) => (
                      <Badge key={s} variant="outline" className="text-xs">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {key.revokedAt ? (
                    <Badge variant="outline">{t("settings.apiKeys.revoked")}</Badge>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => onRotate(key)}>
                        {t("settings.apiKeys.integration.rotate")}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => onRevoke(key)}>
                        {t("settings.apiKeys.revoke")}
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("settings.apiKeys.integration.empty")}</p>
      )}

      {showCreate ? (
        <CreateIntegrationKeyDialog
          onClose={() => setShowCreate(false)}
          onCreated={(token) => {
            setShowCreate(false);
            setNewToken(token);
          }}
        />
      ) : null}
      {newToken ? <NewApiKeyDialog token={newToken} onClose={() => setNewToken(null)} /> : null}
    </Card>
  );
}
