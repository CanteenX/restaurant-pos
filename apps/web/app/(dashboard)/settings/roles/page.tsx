"use client";

import { useI18n } from "@/lib/i18n/context";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { CreateRoleDialog } from "@/components/settings/create-role-dialog";
import { EditRoleDialog } from "@/components/settings/edit-role-dialog";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDeleteRole, useRoles, type RoleWithPermissions } from "@/hooks/use-roles";
import { ApiError } from "@/lib/api";

export default function RolesPage() {
  const { t } = useI18n();
  const { data: roles, isLoading } = useRoles();
  const deleteRole = useDeleteRole();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleWithPermissions | null>(null);

  const onDelete = (role: RoleWithPermissions) => {
    if (!confirm(t("settings.roles.confirmDelete", { label: role.label }))) return;
    deleteRole.mutate(role.id, {
      onSuccess: () => toast.success(t("settings.roles.deleted", { label: role.label })),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : t("settings.roles.deleteFailed")),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.roles.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.roles.subtitle")}</p>
      </div>

      <SettingsTabs />

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-medium text-foreground">{t("settings.roles.heading")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.roles.intro")}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("settings.roles.create")}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : roles && roles.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.roles.colRole")}</TableHead>
                <TableHead>{t("settings.roles.colType")}</TableHead>
                <TableHead>{t("settings.roles.colPermissions")}</TableHead>
                <TableHead className="text-right">{t("settings.roles.colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-medium text-foreground">
                    {role.label}
                    <div className="text-xs font-normal text-muted-foreground">{role.name}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={role.isSystem ? "secondary" : "outline"} className="font-normal">
                      {role.isSystem ? t("settings.roles.seeded") : t("settings.roles.custom")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t("settings.roles.granted", { count: role.permissions.length })}
                  </TableCell>
                  <TableCell className="text-right">
                    {role.isSystem ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditingRole(role)}>
                          {t("settings.roles.edit")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => onDelete(role)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-sm font-medium text-foreground">{t("settings.roles.emptyTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("settings.roles.emptyHint")}</p>
          </div>
        )}
      </Card>

      {createOpen ? <CreateRoleDialog onClose={() => setCreateOpen(false)} /> : null}
      {editingRole ? (
        <EditRoleDialog
          key={editingRole.id}
          role={editingRole}
          onClose={() => setEditingRole(null)}
        />
      ) : null}
    </div>
  );
}
