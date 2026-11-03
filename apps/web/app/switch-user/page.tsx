"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { PinPad } from "@/components/auth/pin-pad";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { usePinLogin } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api";
import {
  canSubmitPin,
  landingPathFor,
  parseRoster,
  pinFailure,
  readRosterRaw,
  type RosterEntry,
} from "@/lib/pin-keypad";

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

/** Staff who signed in on this till before. Empty during server render. */
function useRoster(): RosterEntry[] {
  const raw = useSyncExternalStore(subscribe, readRosterRaw, () => null);
  return useMemo(() => parseRoster(raw), [raw]);
}

function UserTiles({ users, onPick }: { users: RosterEntry[]; onPick: (u: RosterEntry) => void }) {
  if (users.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No one has signed in on this device yet. Sign in once with your password and your tile will appear here.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {users.map((u) => (
        <li key={u.id}>
          <button
            type="button"
            onClick={() => onPick(u)}
            className="flex w-full touch-manipulation flex-col items-center gap-2 rounded-2xl border border-border bg-card px-3 py-5 transition-colors hover:bg-secondary active:bg-secondary/80"
          >
            <Avatar className="h-14 w-14">
              <AvatarFallback className="bg-primary text-lg font-medium text-primary-foreground">
                {initials(u.name)}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium text-foreground">{u.name}</span>
            {u.roleName && <span className="text-xs text-muted-foreground">{u.roleName}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function SwitchUserPage() {
  const router = useRouter();
  const users = useRoster();
  const pinLogin = usePinLogin();
  const [picked, setPicked] = useState<RosterEntry | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  const pick = (u: RosterEntry | null) => {
    setPicked(u);
    setPin("");
    setError(null);
  };

  const submit = useCallback(() => {
    if (!picked || !canSubmitPin(pin) || pinLogin.isPending) return;
    setError(null);
    pinLogin.mutate(
      { userId: picked.id, pin },
      {
        onSuccess: (data) => router.replace(landingPathFor(data.user)),
        onError: (err) => {
          setPin("");
          setError(err instanceof ApiError ? pinFailure(err.status, err.message).message : pinFailure(undefined).message);
        },
      },
    );
  }, [picked, pin, pinLogin, router]);

  return (
    <main className="flex flex-1 items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Logo size={40} />
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {picked ? `Hi, ${picked.name}` : "Switch user"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {picked ? "Enter your PIN" : "Tap your name to sign in with your PIN"}
          </p>
        </div>

        {picked ? (
          <div className="flex flex-col items-center gap-5">
            <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={pinLogin.isPending} />
            {error && (
              <div
                role="alert"
                className="flex w-full max-w-xs items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button
              className="h-12 w-full max-w-xs text-base"
              onClick={submit}
              disabled={!canSubmitPin(pin) || pinLogin.isPending}
            >
              {pinLogin.isPending ? "Signing in…" : "Unlock"}
            </Button>
            <Button variant="ghost" onClick={() => pick(null)}>
              <ArrowLeft className="h-4 w-4" />
              Choose someone else
            </Button>
          </div>
        ) : (
          <UserTiles users={users} onPick={pick} />
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link href="/login" className="font-medium text-foreground hover:underline">
            Sign in with password instead
          </Link>
        </p>
      </div>
    </main>
  );
}
