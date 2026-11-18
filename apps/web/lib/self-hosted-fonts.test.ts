// Guard for #187: web fonts must be self-hosted. The Google next/font loader downloads
// fonts from fonts.googleapis.com at BUILD time, which breaks offline builds
// and cloud VMs that block Google. These tests fail if it is reintroduced or
// if a self-hosted font file goes missing.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "public", "test-results"]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;
const FONTS_FILE = join(WEB_ROOT, "app", "fonts.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return SOURCE_EXT.test(name) ? [full] : [];
  });
}

test("no web source imports the Google next/font loader", () => {
  const banned = "next/font/" + "google"; // split so this file does not match itself
  const offenders = sourceFiles(WEB_ROOT).filter((file) => readFileSync(file, "utf8").includes(banned));
  assert.deepEqual(offenders, [], `use next/font/local (see app/fonts.ts) instead of ${banned}`);
});

test("app/fonts.ts loads fonts with next/font/local", () => {
  const source = readFileSync(FONTS_FILE, "utf8");
  assert.match(source, /from "next\/font\/local"/);
  for (const cssVar of ["--font-geist-sans", "--font-geist-mono", "--font-devanagari"]) {
    assert.ok(source.includes(`"${cssVar}"`), `fonts.ts must define ${cssVar}`);
  }
});

test("every local font src in app/fonts.ts exists on disk", () => {
  const source = readFileSync(FONTS_FILE, "utf8");
  const srcPaths = [...source.matchAll(/["'](\.{1,2}\/[^"']+\.woff2)["']/g)].map((m) => m[1]);
  assert.ok(srcPaths.length > 0, "expected at least one .woff2 src in fonts.ts");
  for (const rel of srcPaths) {
    const abs = resolve(dirname(FONTS_FILE), rel);
    assert.ok(existsSync(abs), `font file missing: ${rel} (run pnpm install)`);
  }
});

// OFL-1.1 §2: every redistributed copy must carry the licence. The Docker image
// ships public/ but not node_modules, so the texts are committed under
// public/licenses/ and must stay identical to the installed packages' copies.
const FONT_LICENCES: Array<[string, string]> = [
  ["public/licenses/geist-OFL.txt", "node_modules/geist/LICENSE.txt"],
  [
    "public/licenses/noto-sans-devanagari-OFL.txt",
    "node_modules/@fontsource-variable/noto-sans-devanagari/LICENSE",
  ],
];

test("font OFL licence texts ship in public/licenses and match the packages", () => {
  for (const [shipped, upstream] of FONT_LICENCES) {
    const shippedPath = join(WEB_ROOT, shipped);
    assert.ok(existsSync(shippedPath), `missing ${shipped}`);
    const text = readFileSync(shippedPath, "utf8");
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.equal(text, readFileSync(join(WEB_ROOT, upstream), "utf8"), `${shipped} differs from ${upstream}`);
  }
});
