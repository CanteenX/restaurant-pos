// What the updater sidecar reports (GET /api/v1/system/update/progress,
// passed through from updater/server.js) and what the UI should do with it.
// Text comes from the settings.updates.* dictionary keys via `t`.
export interface UpdateProgress {
  state: string;
  version?: string | null;
  step?: string | null;
  error?: string | null;
  rolledBackTo?: string | null;
}

export type ProgressView =
  | { kind: "wait" | "done" | "idle"; message?: undefined }
  | { kind: "failed" | "rolled_back" | "rollback_failed"; message: string };

// The keys used here; any translator over a superset of them (the app's
// TranslationKey, or a plain string translator in tests) fits.
type UpdateKey =
  | "settings.updates.failed"
  | "settings.updates.unknownError"
  | "settings.updates.rolledBack"
  | "settings.updates.rolledBackPrevious"
  | "settings.updates.rollbackFailed"
  | "settings.updates.reason";
type T = (key: UpdateKey, vars?: Record<string, string | number>) => string;

export function describeProgress(p: UpdateProgress, t: T): ProgressView {
  const reason = p.error ? ` ${t("settings.updates.reason", { error: p.error })}` : "";
  switch (p.state) {
    case "pulling":
    case "restarting":
      return { kind: "wait" };
    case "done":
      return { kind: "done" };
    case "error":
      return {
        kind: "failed",
        message: t("settings.updates.failed", { error: p.error ?? t("settings.updates.unknownError") }),
      };
    case "rolled_back":
      return {
        kind: "rolled_back",
        message:
          (p.version && p.rolledBackTo
            ? t("settings.updates.rolledBack", { version: p.version, previous: p.rolledBackTo })
            : t("settings.updates.rolledBackPrevious")) + reason,
      };
    case "rollback_failed":
      // The updater could not put the old version back healthy (or at all):
      // nothing can be assumed to be running, so say so and what to do.
      return {
        kind: "rollback_failed",
        message: t("settings.updates.rollbackFailed", { version: p.version ?? "?" }) + reason,
      };
    default:
      return { kind: "idle" };
  }
}
