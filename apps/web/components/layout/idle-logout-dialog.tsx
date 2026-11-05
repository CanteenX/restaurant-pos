"use client";

import { useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser, useLogout } from "@/hooks/use-auth";
import { useIdleLogout } from "@/hooks/use-idle-logout";
import { useI18n } from "@/lib/i18n/context";
import { idleSettings } from "@/lib/idle-timer";

/**
 * Warns staff shortly before an idle sign-out and signs out when the time
 * runs out (issue #18). Mounted once in the dashboard layout. The window
 * is the server's SESSION_IDLE_MINUTES; the kitchen display is exempt.
 */
export function IdleLogoutDialog() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const { data: me } = useCurrentUser();
  const logout = useLogout();
  // mutateAsync, not mutate callbacks: clearing the cache on sign-out can
  // unmount this component first, which drops per-call callbacks. Even if
  // the request fails (server down), leave the signed-in screens.
  const signOut = () => {
    void logout
      .mutateAsync()
      .catch(() => undefined)
      .finally(() => router.replace("/login"));
  };
  const { state, stay } = useIdleLogout(signOut, idleSettings(me?.session, pathname));
  // Focus the safe choice: a stray Enter must not sign the user out.
  const stayRef = useRef<HTMLButtonElement>(null);
  const seconds = state.phase === "warning" ? Math.ceil(state.remainingMs / 1000) : 0;

  return (
    <Dialog open={state.phase === "warning"} onOpenChange={(open) => !open && stay()}>
      <DialogContent className="max-w-sm" showCloseButton={false} initialFocus={stayRef}>
        <DialogHeader>
          <DialogTitle>{t("session.idle.title")}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {t("session.idle.body", { seconds })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={signOut} disabled={logout.isPending}>
            {t("session.idle.signOutNow")}
          </Button>
          <Button ref={stayRef} onClick={stay}>
            {t("session.idle.stay")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
