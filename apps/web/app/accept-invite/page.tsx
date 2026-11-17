"use client";

import type { InviteInfoView } from "@nventra/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthNotice, AuthShell } from "@/components/auth/auth-shell";
import { NewPasswordForm } from "@/components/auth/new-password-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { takeTokenFromHash } from "@/hooks/use-password-reset";
import { api, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

// Public page behind a staff invite email (#223): set a password, which
// activates the account. The token travels in the URL fragment and is sent
// only in POST bodies, never in a URL the server sees.
export default function AcceptInvitePage() {
  const { t } = useI18n();
  // undefined = not read yet (first render matches the server HTML).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount
    setToken(takeTokenFromHash());
  }, []);

  const info = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.post<InviteInfoView>("/auth/invite/inspect", { token }),
    enabled: Boolean(token),
    retry: false,
    staleTime: Infinity,
  });
  const accept = useMutation({
    mutationFn: (password: string) => api.post<{ ok: true }>("/auth/invite/accept", { token, password }),
  });

  const onSubmit = (password: string) => {
    setError(null);
    accept.mutate(password, {
      onSuccess: () => setDone(true),
      onError: (err) =>
        setError(
          err instanceof ApiError && err.status === 400
            ? t("auth.invite.invalidLink")
            : err instanceof ApiError && err.status === 429
              ? t("auth.common.tooManyTries")
              : t("auth.common.serverError"),
        ),
    });
  };

  const invalid = token === null || info.isError;
  const subtitle = info.data
    ? t("auth.invite.subtitle", { name: info.data.name, restaurant: info.data.restaurantName, role: info.data.roleLabel })
    : undefined;

  return (
    <AuthShell title={t("auth.invite.title")} subtitle={done ? undefined : subtitle}>
      {done ? (
        <div className="flex flex-col gap-5">
          <AuthNotice tone="success">{t("auth.invite.done")}</AuthNotice>
          <Button render={<Link href="/login" />} className="h-12 text-base">
            {t("auth.common.signIn")}
          </Button>
        </div>
      ) : invalid ? (
        <AuthNotice tone="error">{t("auth.invite.invalidLink")}</AuthNotice>
      ) : info.data ? (
        <NewPasswordForm
          submitLabel={t("auth.invite.submit")}
          pending={accept.isPending}
          error={error}
          onSubmit={onSubmit}
        />
      ) : (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      )}
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-muted-foreground hover:underline">
          {t("auth.common.backToSignIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
