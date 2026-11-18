// Form state for the email template editor (#221). Pure and dependency-light
// so it can be unit-tested with `node --test`. Validation reuses the shared
// Zod schema the API applies, plus the per-template placeholder whitelist.
import {
  emailTemplateUpdateSchema,
  unknownEmailPlaceholders,
  type EmailTemplateKey,
  type EmailTemplateUpdateDto,
  type EmailTemplateView,
} from "@nventra/types";

/** What the inputs hold: every text field as a plain string. */
export interface TemplateDraft {
  subject: string;
  heading: string;
  body: string;
  buttonText: string;
  buttonUrl: string;
  footer: string;
  enabled: boolean;
}

export type DraftField = "subject" | "heading" | "body" | "buttonText" | "buttonUrl" | "footer";
export const DRAFT_FIELDS: readonly DraftField[] = ["subject", "heading", "body", "buttonText", "buttonUrl", "footer"];

export type DraftErrorCode = "required" | "tooLong" | "link" | "buttonPair" | "placeholder" | "invalid";
export interface DraftError {
  code: DraftErrorCode;
  /** Offending placeholder names, for `placeholder`. */
  names?: string[];
}
export type DraftErrors = Partial<Record<DraftField, DraftError>>;
export type DraftValidation = { ok: true; dto: EmailTemplateUpdateDto } | { ok: false; errors: DraftErrors };

/** Preview pane widths in CSS px. */
export const PREVIEW_WIDTHS = { desktop: 600, mobile: 375 } as const;
export type PreviewDevice = keyof typeof PREVIEW_WIDTHS;

export function draftFromView(view: EmailTemplateView): TemplateDraft {
  return {
    subject: view.subject,
    heading: view.heading,
    body: view.body,
    buttonText: view.buttonText ?? "",
    buttonUrl: view.buttonUrl ?? "",
    footer: view.footer ?? "",
    enabled: view.enabled,
  };
}

const blankToNull = (v: string): string | null => (v.trim() ? v : null);

export function draftToDto(draft: TemplateDraft): EmailTemplateUpdateDto {
  return {
    subject: draft.subject,
    heading: draft.heading,
    body: draft.body,
    buttonText: blankToNull(draft.buttonText),
    buttonUrl: blankToNull(draft.buttonUrl),
    footer: blankToNull(draft.footer),
    enabled: draft.enabled,
  };
}

export function isDraftDirty(view: EmailTemplateView, draft: TemplateDraft): boolean {
  const saved = draftFromView(view);
  return saved.enabled !== draft.enabled || DRAFT_FIELDS.some((f) => saved[f] !== draft[f]);
}

function codeForIssue(code: string): DraftErrorCode {
  if (code === "too_small") return "required";
  if (code === "too_big") return "tooLong";
  if (code === "custom") return "link";
  return "invalid";
}

/** Validates like the API does; error codes are translated by the page. */
export function validateDraft(key: EmailTemplateKey, draft: TemplateDraft): DraftValidation {
  const errors: DraftErrors = {};
  const hasText = !!draft.buttonText.trim();
  if (hasText !== !!draft.buttonUrl.trim()) errors[hasText ? "buttonUrl" : "buttonText"] = { code: "buttonPair" };

  for (const field of DRAFT_FIELDS) {
    const names = unknownEmailPlaceholders(key, [draft[field]]);
    if (names.length > 0 && !errors[field]) errors[field] = { code: "placeholder", names };
  }

  const parsed = emailTemplateUpdateSchema.safeParse(draftToDto(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as DraftField | undefined;
      if (field && DRAFT_FIELDS.includes(field) && !errors[field]) errors[field] = { code: codeForIssue(issue.code) };
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, dto: parsed.data };
}

/**
 * Inserts `{{name}}` over the selection [start, end). Returns null when the
 * template does not allow `name`, so chips can only add valid placeholders.
 */
export function insertPlaceholder(
  text: string,
  start: number,
  end: number,
  name: string,
  allowed: readonly string[],
): { text: string; caret: number } | null {
  if (!allowed.includes(name)) return null;
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const token = `{{${name}}}`;
  return { text: text.slice(0, from) + token + text.slice(to), caret: from + token.length };
}

export type SendTestErrorKind = "noEmail" | "rateLimited" | "notConfigured" | "failed";

/** Maps a send-test failure (status + API message) to a translated message kind. */
export function sendTestErrorKind(status: number, message: string): SendTestErrorKind {
  if (status === 429) return "rateLimited";
  if (status === 400 && /no email address/i.test(message)) return "noEmail";
  if (status === 400 && /not set up/i.test(message)) return "notConfigured";
  return "failed";
}
