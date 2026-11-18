const ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function tallyExportPath(branchId: string, from: string, to: string): string {
  const p = new URLSearchParams({ branchId, from, to });
  return `/accounting/tally-export?${p.toString().replace(/\+/g, "%20")}`;
}

/** Returns an error message, or null when the range is valid. */
export function validateTallyRange(from: string, to: string): string | null {
  if (!ISO.test(from) || !ISO.test(to)) return "Pick valid from and to dates";
  if (from > to) return "The start date must be on or before the end date";
  return null;
}

export const tallyFilename = (from: string, to: string) => `tally-${from}_${to}.xml`;

export function parseDownloadFilename(header: string | null, fallback: string): string {
  const m = header?.match(/filename="([^"]+)"/);
  return m?.[1] ?? fallback;
}

/** Only the fields the user actually changed, trimmed; blanks are ignored. */
export function mappingChanges(
  saved: Record<string, string>,
  draft: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft)) {
    const t = v.trim();
    if (t && t !== saved[k]) out[k] = t;
  }
  return out;
}
