"use client";

import { useI18n } from "@/lib/i18n/context";
import { Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { DepartmentsCard } from "@/components/settings/departments-card";
import { StaffAccessDialog } from "@/components/settings/staff-access-dialog";
import { AddStaffDialog } from "@/components/settings/add-staff-dialog";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDeleteStaff, useDepartments, useStaff, useUpdateStaff, type StaffMember } from "@/hooks/use-staff";
import { api, ApiError } from "@/lib/api";
import { useState } from "react";

export default function StaffPage() {
  const { t } = useI18n();
  const { data: staff, isLoading } = useStaff();
  const { data: currentUser } = useCurrentUser();
  const updateStaff = useUpdateStaff();
  const deleteStaff = useDeleteStaff();
  const { data: departments } = useDepartments();
  const [dept, setDept] = useState<string>("all");
  const visible = staff?.filter((m) => dept === "all" || (dept === "none" ? !m.departmentId : m.departmentId === dept));
  const canEditAccess = currentUser?.user.permissions.includes("roles.manage") ?? false;

  const onResetTwoFactor = (member: StaffMember) => {
    if (!confirm(t("settings.staff.reset2faConfirm", { name: member.name }))) return;
    api.post(`/auth/2fa/reset/${member.id}`).then(
      () => toast.success(t("settings.staff.reset2faDone", { name: member.name })),
      (err) => toast.error(err instanceof ApiError ? err.message : t("settings.staff.reset2faFailed")),
    );
  };

  const onDelete = (member: StaffMember) => {
    if (!confirm(t("settings.staff.deleteConfirm", { name: member.name }))) return;
    deleteStaff.mutate(member.id, {
      onSuccess: () => toast.success(t("settings.staff.deleted", { name: member.name })),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : t("settings.staff.deleteFailed")),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-tight text-foreground">{t("settings.staff.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.staff.subtitle")}</p>
      </div>

      <SettingsTabs />

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-[18px] font-medium text-foreground">{t("settings.staff.heading")}</h2>
          <AddStaffDialog />
        </div>

        {departments && departments.length > 0 && (
          <div role="group" aria-label={t("settings.staff.filterByDepartment")} className="flex flex-wrap gap-1.5">
            {[{ id: "all", name: t("settings.staff.everyone") }, ...departments, { id: "none", name: t("settings.staff.noDepartment") }].map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={dept === d.id}
                onClick={() => setDept(d.id)}
                className={`min-h-8 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  dept === d.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 rounded-lg" />
            ))}
          </div>
        ) : visible && visible.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.staff.colName")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("settings.staff.colContact")}</TableHead>
                <TableHead>{t("settings.staff.colRole")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("settings.staff.colDepartment")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("settings.staff.colBranches")}</TableHead>
                <TableHead className="text-right">{t("settings.staff.colActive")}</TableHead>
                <TableHead className="sm:w-64" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium text-foreground">{member.name}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {member.email || member.phone || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal">
                      {member.role.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{member.department?.name ?? "—"}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {member.branches.map((b) => b.branch.name).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      aria-label={t("settings.staff.activeAria", { name: member.name })}
                      checked={member.isActive}
                      onCheckedChange={(checked) =>
                        updateStaff.mutate(
                          { id: member.id, dto: { isActive: checked } },
                          {
                            onSuccess: () =>
                              toast.success(
                                t(checked ? "settings.staff.enabled" : "settings.staff.disabled", { name: member.name }),
                              ),
                            onError: (err) =>
                              toast.error(err instanceof ApiError ? err.message : t("settings.staff.updateFailed")),
                          },
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {member.id !== currentUser?.user.id && (
                      <div className="flex items-center justify-end gap-1">
                        {canEditAccess && <StaffAccessDialog member={member} />}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs text-muted-foreground"
                          title={t("settings.staff.reset2faTitle")}
                          onClick={() => onResetTwoFactor(member)}
                        >
                          {t("settings.staff.reset2fa")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title={t("settings.staff.deleteTitle")}
                          onClick={() => onDelete(member)}
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
            <p className="text-sm font-medium text-foreground">{staff && staff.length > 0 ? t("settings.staff.emptyFilteredTitle") : t("settings.staff.emptyTitle")}</p>
            <p className="text-sm text-muted-foreground">{staff && staff.length > 0 ? t("settings.staff.emptyFilteredHint") : t("settings.staff.emptyHint")}</p>
          </div>
        )}
      </Card>

      <DepartmentsCard />
    </div>
  );
}
