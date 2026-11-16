// The one branded email layout. Table-based with inline styles so it holds up
// in Gmail (web and app, which strip <style> in some views), Outlook desktop
// (Word engine: no max-width, hence the MSO ghost table) and Apple Mail.
// 600px wide, fluid below that; a <style> block only adds progressive
// enhancements (mobile padding, dark mode). No external CSS, fonts or JS.
import { escapeHtml } from './escape';
import type { MarkdownStyles } from './markdown';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const PAGE_BG = '#f4f4f5';
const DARK_TEXT = '#111827';

export const BODY_STYLES: MarkdownStyles = {
  p: `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};`,
  list: `margin:0 0 16px;padding:0 0 0 24px;font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};`,
  li: 'margin:0 0 6px;',
  a: 'color:inherit;text-decoration:underline;',
};

export const FOOTER_STYLES: MarkdownStyles = {
  ...BODY_STYLES,
  a: `color:${MUTED};text-decoration:underline;`,
};

export interface LayoutParts {
  title: string;
  preheader: string;
  color: string;
  headerText: string;
  logoUrl: string | null;
  headingHtml: string;
  bodyHtml: string;
  button: { text: string; url: string } | null;
  footerLinesHtml: string[];
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** White or near-black, whichever reads better on `hex` (#rrggbb). */
export function textColorOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance(DARK_TEXT) + 0.05);
  return onWhite >= onDark ? '#ffffff' : DARK_TEXT;
}

function header(p: LayoutParts, fg: string): string {
  const name = escapeHtml(p.headerText);
  const logo = p.logoUrl
    ? `<img src="${escapeHtml(p.logoUrl)}" alt="${name}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;outline:none;margin:0 0 8px;">`
    : '';
  return `<tr><td class="px" bgcolor="${p.color}" style="background-color:${p.color};padding:24px 40px;border-radius:12px 12px 0 0;">${logo}<div style="font-family:${FONT};font-size:20px;font-weight:700;line-height:1.3;color:${fg};">${name}</div></td></tr>`;
}

function button(p: LayoutParts, fg: string): string {
  if (!p.button) return '';
  const href = escapeHtml(p.button.url);
  const label = escapeHtml(p.button.text);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>` +
    `<td align="center" bgcolor="${p.color}" style="border-radius:8px;background-color:${p.color};">` +
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:${fg};text-decoration:none;border-radius:8px;">${label}</a>` +
    `</td></tr></table>` +
    `<p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};" class="muted">If the button doesn't work, copy this link into your browser:<br><a href="${href}" style="color:${MUTED};word-break:break-all;">${href}</a></p>`
  );
}

function card(p: LayoutParts, fg: string): string {
  const heading = p.headingHtml
    ? `<h1 class="fg" style="margin:0 0 20px;font-family:${FONT};font-size:24px;font-weight:700;line-height:1.3;color:${DARK_TEXT};">${p.headingHtml}</h1>`
    : '';
  return `<tr><td class="card px" bgcolor="#ffffff" style="background-color:#ffffff;padding:32px 40px;border-radius:0 0 12px 12px;"><div class="fg" style="font-family:${FONT};font-size:16px;line-height:1.6;color:${TEXT};">${heading}${p.bodyHtml}${button(p, fg)}</div></td></tr>`;
}

function footer(p: LayoutParts): string {
  const lines = p.footerLinesHtml
    .map(
      (l) =>
        `<p class="muted" style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${l}</p>`,
    )
    .join('');
  return `<tr><td class="px" align="center" style="padding:24px 40px 8px;text-align:center;">${lines}</td></tr>`;
}

const HEAD_STYLE =
  '@media only screen and (max-width:620px){.container{width:100% !important;}.px{padding-left:20px !important;padding-right:20px !important;}.outer{padding:0 !important;}}' +
  '@media (prefers-color-scheme:dark){.bg{background-color:#111113 !important;}.card{background-color:#1c1c1f !important;}.fg,.fg p,.fg li,.fg h1,.fg strong,.fg em{color:#f4f4f5 !important;}.muted,.muted a{color:#a1a1aa !important;}}';

/** Full HTML document for one email. All text in `parts` must already be safe HTML. */
export function renderLayout(p: LayoutParts): string {
  const fg = textColorOn(p.color);
  const preheader = escapeHtml(p.preheader);
  return (
    `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${escapeHtml(p.title)}</title><style>${HEAD_STYLE}</style></head>` +
    `<body class="bg" style="margin:0;padding:0;width:100%;background-color:${PAGE_BG};-webkit-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>` +
    `<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};"><tr><td class="outer" align="center" style="padding:24px 12px;">` +
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;">` +
    header(p, fg) +
    card(p, fg) +
    footer(p) +
    `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`
  );
}
