"use client";

import { useI18n } from "@/lib/i18n/context";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranch } from "@/hooks/use-branch";
import { useCreateStaff, useDepartments, useStaffRoles } from "@/hooks/use-staff";
import { ApiError } from "@/lib/api";
import { usePasswordResetEnabled } from "@/hooks/use-password-reset";

export function AddStaffDialog() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  // #223: email a set-your-password link instead (needs SMTP + PUBLIC_URL,
  // the same server flag that enables password reset).
  const [invite, setInvite] = useState(false);
  const canInvite = usePasswordResetEnabled().data?.enabled === true;
  const [roleId, setRoleId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const { branches } = useBranch();
  const [branchIds, setBranchIds] = useState<string[]>([]);

  const { data: roles } = useStaffRoles();
  const { data: departments } = useDepartments();
  const createStaff = useCreateStaff();

  const reset = () => {
    setName("");
    setEmail("");
    setPhone("");
    setPassword("");
    setInvite(false);
    setRoleId("");
    setDepartmentId("");
    setBranchIds([]);
  };

  const toggleBranch = (id: string) => {
    setBranchIds((prev) => (prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id]));
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleId) {
      toast.error(t("settings.addStaff.chooseRole"));
      return;
    }
    if (branchIds.length === 0) {
      toast.error(t("settings.addStaff.selectBranch"));
      return;
    }
    if (invite && !email) {
      toast.error(t("settings.addStaff.inviteNeedsEmail"));
      return;
    }
    createStaff.mutate(
      {
        name,
        email: email || undefined,
        phone: phone || undefined,
        ...(invite ? { invite: true } : { password }),
        roleId,
        branchIds,
        departmentId: departmentId || undefined,
      },
      {
        onSuccess: (created) => {
          if (created.inviteSent === false) {
            toast.error(t("settings.addStaff.inviteNotSent", { name }));
          } else {
            toast.success(
              t(invite ? "settings.addStaff.invited" : "settings.addStaff.added", { name }),
            );
          }
          setOpen(false);
          reset();
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : t("settings.addStaff.addFailed")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm">{t("settings.addStaff.trigger")}</Button>} />
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("settings.addStaff.title")}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="s-name">{t("settings.addStaff.name")}</Label>
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="s-email">{t("settings.addStaff.email")}</Label>
              <Input id="s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="s-phone">{t("settings.addStaff.phone")}</Label>
              <Input id="s-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>

          {canInvite && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={invite}
                onCheckedChange={(v) => setInvite(Boolean(v))}
                aria-describedby="s-invite-hint"
              />
              <span className="flex flex-col gap-0.5">
                {t("settings.addStaff.invite")}
                <span id="s-invite-hint" className="text-xs text-muted-foreground">
                  {t("settings.addStaff.inviteHint")}
                </span>
              </span>
            </label>
          )}

          {!invite && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="s-password">{t("settings.addStaff.password")}</Label>
              <PasswordInput
                id="s-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label>{t("settings.addStaff.role")}</Label>
            <Select value={roleId} onValueChange={(v) => setRoleId(v ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder={t("settings.addStaff.selectRole")} />
              </SelectTrigger>
              <SelectContent>
                {roles?.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {departments && departments.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label>{t("settings.addStaff.department")}</Label>
              <Select value={departmentId} onValueChange={(v) => setDepartmentId(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder={t("settings.addStaff.noDepartment")} />
                </SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label>{t("settings.addStaff.branches")}</Label>
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={branchIds.includes(b.id)}
                    onCheckedChange={() => toggleBranch(b.id)}
                  />
                  {b.name}
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={createStaff.isPending}>
              {createStaff.isPending ? t("settings.addStaff.adding") : t("settings.addStaff.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
