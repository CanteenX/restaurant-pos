"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLogout } from "@/hooks/use-auth";
import { useIdleLogout } from "@/hooks/use-idle-logout";

/**
 * Warns staff shortly before an idle sign-out and signs out when the time
 * runs out (issue #18). Mounted once in the dashboard layout.
 */
export function IdleLogoutDialog() {
  const router = useRouter();
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
  const { state, stay } = useIdleLogout(signOut);
  // Focus the safe choice: a stray Enter must not sign the user out.
  const stayRef = useRef<HTMLButtonElement>(null);
  const seconds = state.phase === "warning" ? Math.ceil(state.remainingMs / 1000) : 0;

  return (
    <Dialog open={state.phase === "warning"} onOpenChange={(open) => !open && stay()}>
      <DialogContent className="max-w-sm" showCloseButton={false} initialFocus={stayRef}>
        <DialogHeader>
          <DialogTitle>Still there?</DialogTitle>
          <DialogDescription>
            You will be signed out in <span className="font-semibold tabular-nums">{seconds}</span> seconds
            because this screen has been idle.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={signOut} disabled={logout.isPending}>
            Sign out now
          </Button>
          <Button ref={stayRef} onClick={stay}>
            Stay signed in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
