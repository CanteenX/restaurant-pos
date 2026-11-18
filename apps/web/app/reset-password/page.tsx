"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthNotice, AuthShell } from "@/components/auth/auth-shell";
import { NewPasswordForm } from "@/components/auth/new-password-form";
import { Button } from "@/components/ui/button";
import { takeTokenFromHash, useConfirmPasswordReset } from "@/hooks/use-password-reset";
import { ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

// Sets a new password from an emailed link (#224). The token travels in the
// URL fragment (#token=...), which the browser never sends to any server.
export default function ResetPasswordPage() {
  const { t } = useI18n();
  const confirm = useConfirmPasswordReset();
  // undefined = not read yet (first render matches the server HTML).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount
    setToken(takeTokenFromHash());
  }, []);

  const onSubmit = (password: string) => {
    if (!token) return;
    setError(null);
    confirm.mutate(
      { token, password },
      {
        onSuccess: () => setDone(true),
        onError: (err) =>
          setError(
            err instanceof ApiError && err.status === 400
              ? t("auth.reset.invalidLink")
              : err instanceof ApiError && err.status === 429
                ? t("auth.common.tooManyTries")
                : t("auth.common.serverError"),
          ),
      },
    );
  };

  return (
    <AuthShell title={t("auth.reset.title")} subtitle={done ? undefined : t("auth.reset.subtitle")}>
      {done ? (
        <div className="flex flex-col gap-5">
          <AuthNotice tone="success">{t("auth.reset.done")}</AuthNotice>
          <Button render={<Link href="/login" />} className="h-12 text-base">
            {t("auth.common.signIn")}
          </Button>
        </div>
      ) : token === null ? (
        <AuthNotice tone="error">{t("auth.reset.missingToken")}</AuthNotice>
      ) : token ? (
        <NewPasswordForm
          submitLabel={t("auth.reset.submit")}
          pending={confirm.isPending}
          error={error}
          onSubmit={onSubmit}
        />
      ) : null}
      {!done && (
        <p className="mt-6 flex flex-col items-center gap-3 text-center text-sm">
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">
            {t("auth.reset.requestNew")}
          </Link>
          <Link href="/login" className="text-muted-foreground hover:underline">
            {t("auth.common.backToSignIn")}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
