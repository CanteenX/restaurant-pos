import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmailTemplateView } from "@nventra/types";
import {
  draftFromView,
  draftToDto,
  insertPlaceholder,
  isDraftDirty,
  sendTestErrorKind,
  validateDraft,
} from "./email-template-form.ts";

const view: EmailTemplateView = {
  key: "PASSWORD_RESET",
  subject: "Reset your password",
  heading: "Hi {{user.name}}",
  body: "Use the button below.",
  buttonText: "Reset password",
  buttonUrl: "{{reset.url}}",
  footer: null,
  enabled: true,
  isCustom: false,
  placeholders: ["restaurant.name", "restaurant.address", "app.url", "user.name", "reset.url", "reset.expiresIn"],
  updatedAt: null,
};

test("draftFromView turns nulls into empty strings for the inputs", () => {
  const d = draftFromView(view);
  assert.equal(d.footer, "");
  assert.equal(d.buttonUrl, "{{reset.url}}");
  assert.equal(d.enabled, true);
});

test("draftToDto sends blank optional fields as null", () => {
  const dto = draftToDto({ ...draftFromView(view), buttonText: "  ", buttonUrl: "", footer: "" });
  assert.equal(dto.buttonText, null);
  assert.equal(dto.buttonUrl, null);
  assert.equal(dto.footer, null);
  assert.equal(dto.subject, "Reset your password");
});

test("isDraftDirty is false for an untouched draft and true after an edit", () => {
  const d = draftFromView(view);
  assert.equal(isDraftDirty(view, d), false);
  assert.equal(isDraftDirty(view, { ...d, subject: "New" }), true);
  assert.equal(isDraftDirty(view, { ...d, enabled: false }), true);
});

test("validateDraft accepts the default template", () => {
  const r = validateDraft("PASSWORD_RESET", draftFromView(view));
  assert.equal(r.ok, true);
});

test("validateDraft flags an empty subject as required", () => {
  const r = validateDraft("PASSWORD_RESET", { ...draftFromView(view), subject: "   " });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.subject?.code, "required");
});

test("validateDraft flags a button with a label but no link", () => {
  const r = validateDraft("PASSWORD_RESET", { ...draftFromView(view), buttonUrl: "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.buttonUrl?.code, "buttonPair");
});

test("validateDraft rejects unsafe button links and markdown links", () => {
  const r = validateDraft("PASSWORD_RESET", {
    ...draftFromView(view),
    buttonUrl: "javascript:alert(1)",
    body: "[x](javascript:alert(1))",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors.buttonUrl?.code, "link");
    assert.equal(r.errors.body?.code, "link");
  }
});

test("validateDraft names placeholders the template does not allow", () => {
  const r = validateDraft("PASSWORD_RESET", { ...draftFromView(view), heading: "Order {{order.total}}" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.errors.heading, { code: "placeholder", names: ["order.total"] });
});

test("validateDraft flags text over the length limit", () => {
  const r = validateDraft("PASSWORD_RESET", { ...draftFromView(view), subject: "x".repeat(201) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.subject?.code, "tooLong");
});

test("insertPlaceholder replaces the selection and puts the caret after the token", () => {
  const r = insertPlaceholder("Hello world", 6, 11, "user.name", view.placeholders);
  assert.deepEqual(r, { text: "Hello {{user.name}}", caret: 19 });
});

test("insertPlaceholder inserts at the caret with no selection", () => {
  const r = insertPlaceholder("Hi !", 3, 3, "user.name", view.placeholders);
  assert.deepEqual(r, { text: "Hi {{user.name}}!", caret: 16 });
});

test("insertPlaceholder clamps out-of-range positions", () => {
  const r = insertPlaceholder("ab", 10, 99, "app.url", view.placeholders);
  assert.deepEqual(r, { text: "ab{{app.url}}", caret: 13 });
});

test("insertPlaceholder refuses a placeholder the template does not allow", () => {
  const r = insertPlaceholder("ab", 0, 0, "order.total", view.placeholders);
  assert.equal(r, null);
});

test("sendTestErrorKind maps the API contract statuses", () => {
  assert.equal(sendTestErrorKind(429, "Too many test emails"), "rateLimited");
  assert.equal(sendTestErrorKind(400, "Your account has no email address. Add one"), "noEmail");
  assert.equal(sendTestErrorKind(400, "Email is not set up on this server (SMTP_URL / SMTP_FROM)"), "notConfigured");
  assert.equal(sendTestErrorKind(400, "The test email could not be sent."), "failed");
  assert.equal(sendTestErrorKind(500, "boom"), "failed");
});
