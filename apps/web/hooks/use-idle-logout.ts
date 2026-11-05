"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACTIVITY_STORAGE_KEY,
  idleState,
  latestActivity,
  shouldRecordActivity,
  type IdleConfig,
  type IdleState,
} from "@/lib/idle-timer";

const ACTIVE: IdleState = { phase: "active" };
const EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

function readStored(): string | null {
  try {
    return localStorage.getItem(ACTIVITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(at: number) {
  try {
    localStorage.setItem(ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Private mode / blocked storage: this tab still tracks its own input.
  }
}

function stateKey(s: IdleState) {
  return s.phase === "warning" ? `w${Math.ceil(s.remainingMs / 1000)}` : s.phase;
}

/**
 * Tracks staff input (shared across tabs) and reports the idle phase every
 * second. `onExpire` runs once when the window runs out. `stay()` counts as
 * fresh activity (the warning dialog's button). A null `config` (idle
 * sign-out off, or an unattended screen) tracks nothing and never expires.
 */
export function useIdleLogout(onExpire: () => void, config: IdleConfig | null) {
  const last = useRef(0);
  const written = useRef(0);
  const expired = useRef(false);
  const cb = useRef(onExpire);
  const [state, setState] = useState<IdleState>({ phase: "active" });

  useEffect(() => {
    cb.current = onExpire;
  });

  const bump = useRef(() => {
    const now = Date.now();
    last.current = now;
    if (shouldRecordActivity(written.current, now)) {
      written.current = now;
      writeStored(now);
    }
  });

  const idleMs = config?.idleMs;
  const warnMs = config?.warnMs;

  useEffect(() => {
    if (idleMs === undefined || warnMs === undefined) return;
    const cfg = { idleMs, warnMs };
    const record = bump.current;
    written.current = 0;
    record();
    EVENTS.forEach((e) => window.addEventListener(e, record, { passive: true }));
    const tick = () => {
      const now = Date.now();
      last.current = latestActivity(last.current, readStored(), now);
      const next = idleState(last.current, now, cfg);
      // Re-render only when the phase or the shown second changes.
      setState((prev) => (stateKey(prev) === stateKey(next) ? prev : next));
      if (next.phase === "expired" && !expired.current) {
        expired.current = true;
        cb.current();
      }
    };
    const timer = setInterval(tick, 1000);
    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, record));
      clearInterval(timer);
      // Leaving for an exempt screen (or a new window) drops any warning.
      setState({ phase: "active" });
    };
  }, [idleMs, warnMs]);

  const stay = () => {
    written.current = 0;
    bump.current();
    setState({ phase: "active" });
  };

  return { state: config ? state : ACTIVE, stay };
}
