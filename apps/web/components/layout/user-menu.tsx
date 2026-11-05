"use client";

import type { SessionUser } from "@nventra/types";
import { LogOut, MonitorX, Moon, Server, Sun, Trash2, UserRoundCog } from "lucide-react";
import { useState } from "react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DeleteAccountDialog } from "@/components/layout/delete-account-dialog";
import { useLogout, useRevokeMySessions } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useI18n } from "@/lib/i18n/context";
import { forgetBranchChoice } from "@/hooks/use-branch";
import { changeServer, isNativeApp } from "@/lib/native";

function initials(name?: string) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function UserMenu({ user }: { user?: SessionUser }) {
  const { theme, setTheme } = useTheme();
  const logout = useLogout();
  const revokeAll = useRevokeMySessions();
  const { t } = useI18n();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary"
        aria-label="Toggle theme"
      >
        <Sun className="h-[18px] w-[18px] dark:hidden" />
        <Moon className="hidden h-[18px] w-[18px] dark:block" />
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-secondary">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary text-xs font-medium text-primary-foreground">
              {initials(user?.name)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium sm:block">{user?.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            <p className="text-sm font-medium">{user?.name}</p>
            <p className="text-xs font-normal text-muted-foreground">{user?.roleName}</p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              // End this user's session before showing the tiles: a till left on
              // the switch screen must not keep the previous user signed in.
              logout.mutate(undefined, {
                onSuccess: () => {
                  forgetBranchChoice();
                  router.push("/switch-user");
                },
              })
            }
          >
            <UserRoundCog className="h-4 w-4" />
            Switch user
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => logout.mutate(undefined, { onSuccess: () => router.push("/login") })}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (!confirm(t("session.revokeAllConfirm"))) return;
              revokeAll.mutateAsync().then(
                () => router.push("/login"),
                (e) => toast.error(e instanceof ApiError ? e.message : t("session.revokeAllFailed")),
              );
            }}
          >
            <MonitorX className="h-4 w-4" />
            {t("session.revokeAll")}
          </DropdownMenuItem>
          {isNativeApp() && (
            <DropdownMenuItem
              onClick={() => logout.mutate(undefined, { onSuccess: () => changeServer() })}
            >
              <Server className="h-4 w-4" />
              Change server
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive">
            <Trash2 className="h-4 w-4" />
            Delete my account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteAccountDialog open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}
