import { z } from "zod";

// Per-restaurant email templates (#220). Every email the app sends is built
// from structured fields (subject, heading, a safe Markdown body, an optional
// button and a footer) and rendered into one branded layout by the backend.
// Users never write HTML: values are escaped, only whitelisted placeholders
// are allowed, and links are limited to http(s) and mailto.

export const EMAIL_TEMPLATE_KEYS = [
  "MARKETING_CAMPAIGN",
  "REPORT_SCHEDULED",
  "STOCK_ALERT",
  "RECEIPT",
  "STAFF_INVITE",
  "PASSWORD_RESET",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Placeholders every template can use. */
export const COMMON_EMAIL_PLACEHOLDERS = [
  "restaurant.name",
  "restaurant.address",
  "app.url",
] as const;

/** Placeholders each template may use, on top of the common ones. */
export const EMAIL_TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKey, readonly string[]> = {
  MARKETING_CAMPAIGN: ["customer.name", "campaign.name", "campaign.message", "unsubscribe.url"],
  REPORT_SCHEDULED: ["report.title", "report.period", "report.from", "report.to"],
  STOCK_ALERT: ["alert.summary", "alert.details"],
  RECEIPT: ["customer.name", "order.number", "order.date", "order.total", "order.summary", "order.payment", "order.taxId", "receipt.url"],
  STAFF_INVITE: ["staff.name", "invite.role", "invite.url"],
  PASSWORD_RESET: ["user.name", "reset.url", "reset.expiresIn"],
};

export function allowedEmailPlaceholders(key: EmailTemplateKey): string[] {
  return [...COMMON_EMAIL_PLACEHOLDERS, ...EMAIL_TEMPLATE_PLACEHOLDERS[key]];
}

/** Matches `{{ name.path }}`; group 1 is the trimmed name. */
export const EMAIL_PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Every placeholder name used in `text`, in order of appearance (may repeat). */
export function extractEmailPlaceholders(text: string): string[] {
  return [...text.matchAll(EMAIL_PLACEHOLDER_PATTERN)].map((m) => m[1]);
}

/** Placeholder names used in `texts` that `key` does not allow (unique, sorted). */
export function unknownEmailPlaceholders(
  key: EmailTemplateKey,
  texts: readonly (string | null | undefined)[],
): string[] {
  const allowed = new Set(allowedEmailPlaceholders(key));
  const used = texts.flatMap((t) => (t ? extractEmailPlaceholders(t) : []));
  return [...new Set(used.filter((name) => !allowed.has(name)))].sort();
}

/** True for absolute http(s) URLs and mailto: links without whitespace or control characters. */
export function isSafeEmailLink(url: string): boolean {
  const value = url.trim();
  // eslint-disable-next-line no-control-regex
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return /^https?:\/\/[^/?#]+/i.test(value) || /^mailto:[^@]+@[^@]+$/i.test(value);
}

/** Matches a link that starts with a placeholder; group 1 is its name. */
const LEADING_PLACEHOLDER = /^\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/;

/** URL-type placeholders (`reset.url`, `app.url`, ...) are the only ones that may start a link. */
export function isUrlPlaceholder(name: string): boolean {
  return name.endsWith(".url");
}

/**
 * A link as typed into a template: either a safe literal URL, or one that
 * starts with a URL placeholder (`{{reset.url}}`, `{{app.url}}/inventory`).
 * Other placeholders may only appear in the path, query or fragment, never in
 * the scheme or host, so a customer-supplied value (a name, a message) can
 * never decide where a link goes. The filled-in value is checked again when
 * the email is rendered.
 */
export function isAllowedTemplateLink(url: string): boolean {
  const value = url.trim();
  if (/\s/.test(value.replace(EMAIL_PLACEHOLDER_PATTERN, ""))) return false;
  const leading = LEADING_PLACEHOLDER.exec(value);
  if (leading) {
    // `{{app.url}}{{x}}` or `{{app.url}}@evil` would extend the host.
    const rest = value.slice(leading[0].length);
    return isUrlPlaceholder(leading[1]) && (rest === "" || /^[/?#]/.test(rest));
  }
  if (!isSafeEmailLink(value)) return false;
  if (/^mailto:/i.test(value)) return !value.includes("{{");
  const authority = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  return !authority.includes("{{");
}

/** Markdown link targets `[text](url)` found in `text`. */
export function markdownLinkTargets(text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]*\]\(((?:\{\{[^{}]*\}\}|\([^()\s]*\)|[^()\s])*)\)/g)].map((m) => m[1]);
}

export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_HEADING_MAX = 200;
export const EMAIL_BODY_MAX = 10_000;
export const EMAIL_FOOTER_MAX = 1_000;
export const EMAIL_BUTTON_TEXT_MAX = 60;
export const EMAIL_URL_MAX = 2_048;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const emailTemplateKeySchema = z.enum(EMAIL_TEMPLATE_KEYS);

/** Fields of a saved template. Placeholder names are checked per key by the API. */
export const emailTemplateUpdateSchema = z
  .object({
    subject: z.string().trim().min(1, "Enter a subject").max(EMAIL_SUBJECT_MAX),
    heading: z.string().trim().max(EMAIL_HEADING_MAX).default(""),
    body: z.string().max(EMAIL_BODY_MAX).default(""),
    buttonText: optionalText(EMAIL_BUTTON_TEXT_MAX),
    buttonUrl: optionalText(EMAIL_URL_MAX).refine(
      (url) => !url || isAllowedTemplateLink(url),
      "Button links must start with http://, https://, mailto: or a link placeholder such as {{reset.url}}",
    ),
    footer: optionalText(EMAIL_FOOTER_MAX),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!!value.buttonText !== !!value.buttonUrl)
      ctx.addIssue({
        code: "custom",
        path: [value.buttonText ? "buttonUrl" : "buttonText"],
        message: "A button needs both a label and a link",
      });
    for (const field of ["body", "footer"] as const) {
      const bad = markdownLinkTargets(value[field] ?? "").find((u) => !isAllowedTemplateLink(u));
      if (bad !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Links must start with http://, https://, mailto: or a link placeholder such as {{reset.url}}",
        });
    }
  });
export type EmailTemplateUpdateDto = z.infer<typeof emailTemplateUpdateSchema>;

/** Preview an unsaved draft, or the saved/default template when no draft is sent. */
export const emailTemplatePreviewSchema = z
  .object({ draft: emailTemplateUpdateSchema.optional() })
  .strict();
export type EmailTemplatePreviewDto = z.infer<typeof emailTemplatePreviewSchema>;

/**
 * Send a test email. There is deliberately no recipient field: the test always
 * goes to the signed-in user's own account email, so the editor can't be used
 * to mail custom content to other people.
 */
export const emailTemplateTestSchema = z
  .object({ draft: emailTemplateUpdateSchema.optional() })
  .strict();
export type EmailTemplateTestDto = z.infer<typeof emailTemplateTestSchema>;

export const DEFAULT_EMAIL_PRIMARY_COLOR = "#9F1239";

export const emailBrandingSchema = z
  .object({
    primaryColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #9F1239"),
    headerText: optionalText(80),
    footerText: optionalText(EMAIL_FOOTER_MAX),
    logoUrl: optionalText(EMAIL_URL_MAX).refine(
      (url) => !url || (/^https?:\/\//i.test(url) && isSafeEmailLink(url)),
      "The logo must be an http(s) image URL",
    ),
    // Empty string clears it (stored as null).
    replyTo: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid reply-to address")
      .nullable()
      .optional(),
  })
  .strict();
export type EmailBrandingDto = z.infer<typeof emailBrandingSchema>;

/** One template as the API returns it (saved values, or the code default). */
export interface EmailTemplateView {
  key: EmailTemplateKey;
  subject: string;
  heading: string;
  body: string;
  buttonText: string | null;
  buttonUrl: string | null;
  footer: string | null;
  enabled: boolean;
  isCustom: boolean;
  placeholders: string[];
  updatedAt: string | null;
}

export interface EmailBrandingView {
  primaryColor: string;
  headerText: string | null;
  footerText: string | null;
  logoUrl: string | null;
  replyTo: string | null;
}

/** Where "Send test to my email" goes: the signed-in user's own address. */
export interface EmailTestRecipientView {
  /** Null when the account has no email address. */
  email: string | null;
  /** False when the server has no SMTP settings. */
  configured: boolean;
}

export interface EmailPreviewView {
  subject: string;
  html: string;
  text: string;
}
