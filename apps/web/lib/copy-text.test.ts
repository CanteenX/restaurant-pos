import assert from "node:assert/strict";
import { test } from "node:test";
import { copyText } from "./copy-text.ts";

test("uses the async clipboard when it works", async () => {
  let written = "";
  const ok = await copyText("hi", { clipboard: { writeText: async (t) => void (written = t) } });
  assert.equal(ok, true);
  assert.equal(written, "hi");
});

test("falls back when the clipboard is missing (plain http)", async () => {
  let fallbackText = "";
  const ok = await copyText("hi", { clipboard: undefined, fallback: (t) => ((fallbackText = t), true) });
  assert.equal(ok, true);
  assert.equal(fallbackText, "hi");
});

test("falls back when the clipboard rejects", async () => {
  const ok = await copyText("hi", {
    clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    fallback: () => true,
  });
  assert.equal(ok, true);
});

test("returns false when everything fails", async () => {
  assert.equal(await copyText("hi", { clipboard: undefined, fallback: () => false }), false);
  assert.equal(
    await copyText("hi", {
      clipboard: undefined,
      fallback: () => {
        throw new Error("x");
      },
    }),
    false,
  );
});
