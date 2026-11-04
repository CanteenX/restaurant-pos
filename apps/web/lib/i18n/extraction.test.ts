import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findHardcodedStrings } from "./audit.ts";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(full);
    else if (entry.name.endsWith(".tsx")) yield full;
  }
}

// Areas that have been fully moved to t(). Add an area here once its
// extraction PR lands so new hardcoded strings cannot creep back in.
const EXTRACTED_PATHS = [
  "app/(dashboard)/pos",
  "components/pos",
  "components/order",
  "app/(dashboard)/kds",
  "components/kds",
  "app/(dashboard)/inventory",
  "components/inventory",
  "app/(dashboard)/accounting",
  "components/accounting",
  "app/(dashboard)/team",
  "components/team",
  "components/settings",
  "app/(dashboard)/tables",
  "app/(dashboard)/reservations",
  "components/tables",
  "components/reservations",
  "app/(dashboard)/menu",
  "components/menu",
  "app/(dashboard)/reports",
  "components/reports",
  "app/(dashboard)/dashboard",
  "components/dashboard",
  "app/(dashboard)/operations",
  "components/operations",
];

for (const path of EXTRACTED_PATHS) {
  test(`no hardcoded user-facing strings in ${path}`, () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(webRoot, path))) {
      const src = readFileSync(file, "utf8");
      for (const hit of findHardcodedStrings(src)) {
        offenders.push(`${relative(webRoot, file)}: ${hit.text}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
}
