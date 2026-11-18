"use client";

import Link from "next/link";
import { useState } from "react";
import { passwordResetRequestSchema } from "@nventra/types";
import { AuthNotice, AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePasswordResetEnabled, useRequestPasswordReset } from "@/hooks/use-password-reset";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

// "Forgot password?" (#224). The server answers the same for every address,
// so this page never says whether an account exists.
export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const enabled = usePasswordResetEnabled();
  const send = useRequestPasswordReset();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = passwordResetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError(t("auth.forgot.invalidEmail"));
      return;
    }
    send.mutate(parsed.data, {
      onSuccess: () => setSent(true),
      onError: (err) =>
        setError(
          err instanceof ApiError && err.status === 429
            ? t("auth.forgot.tooMany")
            : t("auth.common.serverError"),
        ),
    });
  };

  const unavailable = enabled.data?.enabled === false;

  return (
    <AuthShell title={t("auth.forgot.title")} subtitle={t("auth.forgot.subtitle")}>
      {unavailable ? (
        <AuthNotice tone="error">{t("auth.forgot.unavailable")}</AuthNotice>
      ) : sent ? (
        <AuthNotice tone="success">{t("auth.forgot.sent")}</AuthNotice>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">{t("auth.common.email")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              className="h-11"
              placeholder={t("auth.common.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <Button type="submit" className="h-12 text-base" disabled={send.isPending}>
            {send.isPending ? t("auth.forgot.sending") : t("auth.forgot.submit")}
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t("auth.common.backToSignIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
