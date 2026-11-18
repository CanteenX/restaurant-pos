"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/layout/logo";

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

/** Centered single-card layout shared by the public account pages. */
export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Link href="/">
            <Logo size={44} />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

interface NoticeProps {
  tone: "error" | "success";
  children: React.ReactNode;
}

export function AuthNotice({ tone, children }: NoticeProps) {
  const error = tone === "error";
  const Icon = error ? AlertCircle : CheckCircle2;
  return (
    <div
      role={error ? "alert" : "status"}
      className={
        error
          ? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          : "flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300"
      }
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
