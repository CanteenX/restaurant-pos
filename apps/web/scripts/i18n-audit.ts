// Lists hardcoded (untranslated) UI strings per area of the staff app.
//   pnpm --filter ./apps/web i18n:audit            # counts per area
//   pnpm --filter ./apps/web i18n:audit inventory  # every hit in one area
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { areaOf, findHardcodedStrings } from "../lib/i18n/audit.ts";

const root = new URL("..", import.meta.url).pathname;
const only = process.argv[2];

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(full);
    else if (entry.name.endsWith(".tsx")) yield full;
  }
}

const perArea = new Map<string, { files: number; strings: number; t: number }>();
const lines: string[] = [];
for (const dir of ["app", "components"]) {
  for (const file of tsxFiles(join(root, dir))) {
    const rel = relative(root, file);
    if (rel.startsWith("components/ui/")) continue; // shadcn primitives: no copy
    const area = areaOf(rel);
    const src = readFileSync(file, "utf8");
    const hits = findHardcodedStrings(src);
    const row = perArea.get(area) ?? { files: 0, strings: 0, t: 0 };
    row.files += 1;
    row.strings += hits.length;
    row.t += (src.match(/\bt\(/g) ?? []).length;
    perArea.set(area, row);
    if (only === area) for (const h of hits) lines.push(`${rel}: ${h.text}`);
  }
}

const out = process.stdout;
if (only) {
  out.write(lines.join("\n") + "\n");
} else {
  out.write("area\tfiles\thardcoded\tt() calls\n");
  const rows = [...perArea].sort((a, b) => b[1].strings - a[1].strings);
  for (const [area, r] of rows) out.write(`${area}\t${r.files}\t${r.strings}\t${r.t}\n`);
  const total = rows.reduce((n, [, r]) => n + r.strings, 0);
  out.write(`TOTAL\t\t${total}\n`);
}
