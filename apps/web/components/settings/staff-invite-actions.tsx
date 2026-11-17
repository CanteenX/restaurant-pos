"use client";

import { Button } from "@/components/ui/button";
import { useRevokeStaffInvite, useSendStaffInvite, type StaffMember } from "@/hooks/use-staff";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { toast } from "@/lib/toast";

interface StaffInviteActionsProps {
  member: StaffMember;
}

/**
 * Send / resend / revoke the email invite of a not-yet-active account (#223).
 * The server enforces users.manage and the privilege ceiling; errors toast.
 */
export function StaffInviteActions({ member }: StaffInviteActionsProps) {
  const { t } = useI18n();
  const send = useSendStaffInvite();
  const revoke = useRevokeStaffInvite();
  if (member.isActive || !member.email) return null;
  const pending = Boolean(member.invitePendingUntil);
  const fail = (fallback: string) => (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : fallback);

  const onSend = () =>
    send.mutate(member.id, {
      onSuccess: () => toast.success(t("settings.staff.inviteSent", { name: member.name })),
      onError: fail(t("settings.staff.inviteFailed")),
    });

  const onRevoke = () => {
    if (!confirm(t("settings.staff.inviteRevokeConfirm", { name: member.name }))) return;
    revoke.mutate(member.id, {
      onSuccess: () => toast.success(t("settings.staff.inviteRevoked", { name: member.name })),
      onError: fail(t("settings.staff.inviteFailed")),
    });
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs text-muted-foreground"
        disabled={send.isPending}
        onClick={onSend}
      >
        {pending ? t("settings.staff.inviteResend") : t("settings.staff.inviteSend")}
      </Button>
      {pending && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs text-muted-foreground"
          disabled={revoke.isPending}
          onClick={onRevoke}
        >
          {t("settings.staff.inviteRevoke")}
        </Button>
      )}
    </>
  );
}
