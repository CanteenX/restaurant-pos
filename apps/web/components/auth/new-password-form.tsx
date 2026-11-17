"use client";

import { useState } from "react";
import { newPasswordSchema } from "@nventra/types";
import { AuthNotice } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useI18n } from "@/lib/i18n/context";

interface NewPasswordFormProps {
  submitLabel: string;
  pending: boolean;
  /** Server-side error to show under the fields. */
  error: string | null;
  onSubmit: (password: string) => void;
}

/**
 * New password + confirmation, checked against the shared password policy
 * before it is sent. Used by the reset page and the accept-invite page.
 */
export function NewPasswordForm({ submitLabel, pending, error, onSubmit }: NewPasswordFormProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPasswordSchema.safeParse(password).success) {
      setLocalError(t("auth.password.policy"));
      return;
    }
    if (password !== confirm) {
      setLocalError(t("auth.password.mismatch"));
      return;
    }
    setLocalError(null);
    onSubmit(password);
  };

  const shown = localError ?? error;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-password">{t("auth.password.new")}</Label>
        <PasswordInput
          id="new-password"
          autoComplete="new-password"
          autoFocus
          className="h-11"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("auth.password.hint")}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm-password">{t("auth.password.confirm")}</Label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          className="h-11"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {shown && <AuthNotice tone="error">{shown}</AuthNotice>}
      <Button type="submit" className="h-12 text-base" disabled={pending}>
        {pending ? t("auth.password.saving") : submitLabel}
      </Button>
    </form>
  );
}
