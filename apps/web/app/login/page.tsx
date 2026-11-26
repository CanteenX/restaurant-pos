"use client";

import { loginSchema, type LoginDto } from "@nventra/types";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { AlertCircle } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";
import { usePasswordResetEnabled } from "@/hooks/use-password-reset";
import { useI18n, type TranslationKey } from "@/lib/i18n/context";

const validateLogin: Resolver<LoginDto> = (input) => {
  const parsed = loginSchema.safeParse(input);
  if (parsed.success) return { values: parsed.data, errors: {} };

  const errors: FieldErrors<LoginDto> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "email" || field === "password" || field === "totp") {
      errors[field] = { type: issue.code };
    }
  }
  return { values: {}, errors };
};

function loginError(error: unknown): TranslationKey {
  if (!(error instanceof ApiError)) return "auth.login.connectionError";
  if (error.status === 429) return "auth.common.tooManyTries";
  switch (error.message) {
    case "Invalid login ID or password": return "auth.login.invalidCredentials";
    case "Invalid verification code": return "auth.login.invalidCode";
    case "Too many incorrect codes. Try again in 15 minutes.": return "auth.login.tooManyCodes";
    default: return "auth.common.serverError";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const login = useLogin();
  const { t } = useI18n();
  // Hidden unless this server can email reset links (#224).
  const resetEnabled = usePasswordResetEnabled().data?.enabled === true;
  // Set once the server says this account uses two-factor authentication.
  const [needsCode, setNeedsCode] = useState(false);
  // Shown inline under the form (a toast vanishes before it can be read).
  const [error, setError] = useState<TranslationKey | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginDto>({ resolver: validateLogin });

  const onSubmit = (dto: LoginDto) => {
    setError(null);
    login.mutate(dto, {
      onSuccess: (data) => {
        // A delivery rider has no back-office screens: open their deliveries.
        const user = (data as { user?: { roleName?: string; permissions?: string[] } }).user;
        const rider = user?.roleName === "DELIVERY_STAFF" && user.permissions?.includes("delivery.rider");
        router.push(rider ? "/my-deliveries" : "/dashboard");
      },
      onError: (err) => {
        if (err instanceof ApiError && err.message === "TWO_FACTOR_REQUIRED") {
          setNeedsCode(true);
          return;
        }
        setError(loginError(err));
      },
    });
  };

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(50%_50%_at_50%_0%,color-mix(in_oklch,var(--primary),transparent_90%),transparent)]"
      />
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm py-6"
      >
        <div className="mb-4 flex justify-end">
          <LanguageSwitcher />
        </div>
        <div className="mb-10 flex flex-col items-center gap-2 text-center">
          <Link href="/">
            <Logo size={44} />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t("auth.login.brand")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("auth.login.subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">{t("auth.login.identifier")}</Label>
            <Input
              id="email"
              type="text"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              autoFocus
              className="h-11"
              placeholder={t("auth.login.identifierHint")}
              {...register("email")}
            />
            {errors.email && (
              <p className="text-xs text-destructive">{t("auth.login.identifierInvalid")}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{t("auth.login.password")}</Label>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              enterKeyHint="go"
              className="h-11"
              placeholder={t("auth.login.passwordHint")}
              {...register("password")}
            />
            {errors.password && (
              <p className="text-xs text-destructive">{t("auth.login.passwordInvalid")}</p>
            )}
            {resetEnabled && (
              <Link
                href="/forgot-password"
                className="self-end text-xs font-medium text-primary hover:underline"
              >
                {t("auth.login.forgot")}
              </Link>
            )}
          </div>

          {needsCode && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="totp">{t("auth.login.verificationCode")}</Label>
              <Input
                id="totp"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                placeholder={t("auth.login.verificationHint")}
                {...register("totp")}
              />
              <p className="text-xs text-muted-foreground">
                {t("auth.login.verificationHelp")}
              </p>
              {errors.totp && <p className="text-xs text-destructive">{t("auth.login.verificationInvalid")}</p>}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t(error)}</span>
            </div>
          )}

          <Button type="submit" className="mt-2 h-12 text-base" disabled={login.isPending}>
            {t(login.isPending ? "auth.login.signingIn" : "auth.common.signIn")}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm">
          <Link href="/switch-user" className="font-medium text-primary hover:underline">
            {t("auth.login.switchPin")}
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t("auth.login.newRestaurant")}{" "}
          <Link href="/signup" className="font-medium text-foreground hover:underline">
            {t("auth.login.createAccount")}
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
