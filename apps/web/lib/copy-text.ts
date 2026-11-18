// Copy text to the clipboard. navigator.clipboard only exists on https or
// localhost, so plain-http LAN installs use a hidden textarea + execCommand.
export interface CopyDeps {
  clipboard?: { writeText(text: string): Promise<void> };
  fallback?: (text: string) => boolean;
}

function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(el);
  }
}

export async function copyText(text: string, deps?: CopyDeps): Promise<boolean> {
  const clipboard =
    deps && "clipboard" in deps ? deps.clipboard : typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const fallback = deps?.fallback ?? execCommandCopy;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    return fallback(text);
  } catch {
    return false;
  }
}
