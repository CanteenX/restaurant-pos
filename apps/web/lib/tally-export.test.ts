import assert from "node:assert/strict";
import { test } from "node:test";
import { tallyExportPath, tallyFilename, validateTallyRange, mappingChanges, parseDownloadFilename } from "./tally-export.ts";

test("builds the export path with encoded params", () => {
  assert.equal(
    tallyExportPath("br 1", "2026-11-01", "2026-11-30"),
    "/accounting/tally-export?branchId=br%201&from=2026-11-01&to=2026-11-30",
  );
});

test("validates the date range", () => {
  assert.equal(validateTallyRange("2026-11-01", "2026-11-30"), null);
  assert.match(validateTallyRange("", "2026-11-30") ?? "", /dates/i);
  assert.match(validateTallyRange("2026-12-01", "2026-11-30") ?? "", /before/i);
  assert.match(validateTallyRange("2026-11-01", "2026-13-45x") ?? "", /dates/i);
});

test("default filename matches the server's", () => {
  assert.equal(tallyFilename("2026-11-01", "2026-11-30"), "tally-2026-11-01_2026-11-30.xml");
});

test("parses filename from Content-Disposition, falling back", () => {
  assert.equal(parseDownloadFilename('attachment; filename="tally-a_b.xml"', "x.xml"), "tally-a_b.xml");
  assert.equal(parseDownloadFilename(null, "x.xml"), "x.xml");
});

test("mappingChanges returns only edited, trimmed, non-empty fields", () => {
  const saved = { sales: "Sales", cash: "Cash" };
  assert.deepEqual(mappingChanges(saved, { sales: " Food Sales ", cash: "Cash" }), { sales: "Food Sales" });
  assert.deepEqual(mappingChanges(saved, { sales: "  ", cash: "Cash" }), {});
});
