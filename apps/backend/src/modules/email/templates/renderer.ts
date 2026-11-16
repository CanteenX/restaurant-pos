import {
  DEFAULT_EMAIL_PRIMARY_COLOR,
  type EmailBrandingView,
  type EmailTemplateKey,
} from '@nventra/types';
import type { EmailTemplateFields } from './defaults';
import { escapeHtml } from './escape';
import { BODY_STYLES, FOOTER_STYLES, renderLayout } from './layout';
import {
  fillPlaceholders,
  renderInlineHtml,
  renderInlineText,
  renderMarkdownHtml,
  renderMarkdownText,
  resolveSafeLink,
  type TemplateValues,
} from './markdown';

export interface RenderInput {
  key: EmailTemplateKey;
  template: Omit<EmailTemplateFields, 'enabled'> & { enabled?: boolean };
  branding: EmailBrandingView;
  /** Placeholder values (raw text; escaped here). */
  values: TemplateValues;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const SUBJECT_MAX = 250;
const PREHEADER_MAX = 120;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Footer pieces, in order: template footer, branding footer, name + address. */
function footerParts(input: RenderInput) {
  const { template, branding, values } = input;
  const markdown = [template.footer, branding.footerText].filter(
    (s): s is string => !!s?.trim(),
  );
  const contact = [values['restaurant.name'], values['restaurant.address']]
    .map((s) => oneLine(s ?? ''))
    .filter(Boolean)
    .join(' · ');
  return { markdown, contact };
}

function unsubscribeLink(input: RenderInput): string | null {
  if (input.key !== 'MARKETING_CAMPAIGN') return null;
  return resolveSafeLink('{{unsubscribe.url}}', input.values);
}

function renderText(
  input: RenderInput,
  button: { text: string; url: string } | null,
): string {
  const { template, branding, values } = input;
  const { markdown, contact } = footerParts(input);
  const unsubscribe = unsubscribeLink(input);
  const sections = [
    oneLine(branding.headerText || values['restaurant.name'] || ''),
    oneLine(fillPlaceholders(template.heading, values)),
    renderMarkdownText(template.body, values),
    button ? `${button.text}: ${button.url}` : '',
  ].filter(Boolean);
  const footer = [
    ...markdown.map((m) => renderInlineText(m, values)),
    contact,
    unsubscribe ? `Unsubscribe: ${unsubscribe}` : '',
  ].filter(Boolean);
  return `${sections.join('\n\n')}\n\n—\n${footer.join('\n')}\n`;
}

function resolveButton(input: RenderInput) {
  const { buttonText, buttonUrl } = input.template;
  if (!buttonText || !buttonUrl) return null;
  const url = resolveSafeLink(buttonUrl, input.values);
  const text = oneLine(fillPlaceholders(buttonText, input.values));
  return url && text ? { text, url } : null;
}

/** Renders one email (subject, HTML and plain text) from its template fields. */
export function renderEmail(input: RenderInput): RenderedEmail {
  const { template, branding, values } = input;
  const subject = oneLine(fillPlaceholders(template.subject, values)).slice(
    0,
    SUBJECT_MAX,
  );
  const button = resolveButton(input);
  const text = renderText(input, button);
  const { markdown, contact } = footerParts(input);
  const unsubscribe = unsubscribeLink(input);
  const footerLinesHtml = [
    ...markdown.map((m) => renderInlineHtml(m, values, FOOTER_STYLES)),
    contact ? escapeHtml(contact) : '',
    unsubscribe
      ? `<a href="${escapeHtml(unsubscribe)}" style="${FOOTER_STYLES.a}">Unsubscribe</a> from these emails`
      : '',
  ].filter(Boolean);
  const html = renderLayout({
    title: subject,
    preheader: oneLine(renderMarkdownText(template.body, values)).slice(
      0,
      PREHEADER_MAX,
    ),
    color: /^#[0-9a-f]{6}$/i.test(branding.primaryColor)
      ? branding.primaryColor
      : DEFAULT_EMAIL_PRIMARY_COLOR,
    headerText: oneLine(branding.headerText || values['restaurant.name'] || ''),
    logoUrl:
      branding.logoUrl && resolveSafeLink(branding.logoUrl, {})
        ? branding.logoUrl
        : null,
    headingHtml: escapeHtml(
      oneLine(fillPlaceholders(template.heading, values)),
    ),
    bodyHtml: renderMarkdownHtml(template.body, values, BODY_STYLES),
    button,
    footerLinesHtml,
  });
  return { subject, html, text };
}
