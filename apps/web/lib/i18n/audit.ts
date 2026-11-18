// Heuristic finder for user-visible strings that bypass t(): JSX text nodes
// and literal UI props. Used by scripts/i18n-audit.ts to size the per-area
// extraction work. False positives/negatives are acceptable; it is a
// progress meter, not a gate.

export interface HardcodedString {
  text: string;
  index: number;
}

const UI_PROPS = /\b(?:aria-label|placeholder|title|alt|label)="([^"]*[A-Za-z]{2,}[^"]*)"/g;
// Text between a tag's `>` and the next `<`; skips expressions, code-ish runs
// and the `>` of an arrow function (`=>`).
const JSX_TEXT = /(?<!=)>([^<>{}=;&|]*[A-Za-z]{2,}[^<>{}=;&|]*)</g;

// Source code that sits between two tags, e.g. `) : cond ? (` or `api.get`.
const CODE_LIKE = /^\)|\(\s*$|^[A-Za-z_]+\.[A-Za-z_.]+$/;

export function findHardcodedStrings(source: string): HardcodedString[] {
  const hits: HardcodedString[] = [];
  for (const re of [UI_PROPS, JSX_TEXT]) {
    for (const m of source.matchAll(re)) {
      const text = m[1].replace(/\s+/g, " ").trim();
      if (text && !CODE_LIKE.test(text)) hits.push({ text, index: m.index ?? 0 });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Groups a path (relative to apps/web) into a product area. */
export function areaOf(path: string): string {
  const parts = path.split("/").filter((p) => !/^\(.*\)$/.test(p));
  if (parts[0] === "app" || parts[0] === "components") return parts[1]?.replace(/\.tsx?$/, "") ?? "root";
  return parts[0];
}
