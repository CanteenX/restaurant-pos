"use client";

import { Delete } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { PIN_MAX, pressKey } from "@/lib/pin-keypad";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** Big touch keypad with dot display. Also accepts a physical keyboard. */
export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") return onSubmit();
      const key = e.key === "Backspace" ? "back" : e.key === "Escape" ? "clear" : e.key;
      const next = pressKey(value, key);
      if (next !== value) {
        e.preventDefault();
        onChange(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [value, onChange, onSubmit, disabled]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div
        className="flex h-6 items-center gap-3"
        role="status"
        aria-label={`${value.length} of up to ${PIN_MAX} digits entered`}
        data-testid="pin-dots"
      >
        {Array.from({ length: Math.max(4, value.length) }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border-2 border-primary transition-colors",
              i < value.length ? "bg-primary" : "bg-transparent",
            )}
          />
        ))}
      </div>
      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => onChange(pressKey(value, k))}
            aria-label={k === "back" ? "Delete last digit" : k === "clear" ? "Clear PIN" : k}
            className={cn(
              "flex h-16 select-none items-center justify-center rounded-2xl border border-border bg-card text-2xl font-medium",
              "touch-manipulation transition-colors hover:bg-secondary active:bg-secondary/80 disabled:opacity-50",
              (k === "back" || k === "clear") && "text-base text-muted-foreground",
            )}
          >
            {k === "back" ? <Delete className="h-6 w-6" /> : k === "clear" ? "Clear" : k}
          </button>
        ))}
      </div>
    </div>
  );
}
