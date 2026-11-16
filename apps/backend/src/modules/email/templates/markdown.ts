// A deliberately tiny Markdown subset for email bodies: paragraphs, line
// breaks, **bold**, *italic* / _italic_, [links](https://...) and bullet or
// numbered lists. Anything else (headings, images, code, raw HTML) stays
// visible as escaped text.
//
// We render this ourselves instead of using a Markdown library: the subset is
// small, and escaping every character first means no HTML can get through.
// (marked 18 is ESM-only, which Jest/Nest's CommonJS build cannot load
// directly; markdown-it 15 pulls in a PSF-licensed dependency.)
//
// Placeholders are swapped in only AFTER the Markdown is processed, and their
// values are always escaped, so a customer name like "**x** [y](...)" is
// shown as typed and can never create markup or links.
import { EMAIL_PLACEHOLDER_PATTERN, isSafeEmailLink } from '@nventra/types';
import { escapeHtml } from './escape';

export type TemplateValues = Readonly<Record<string, string>>;

export interface MarkdownStyles {
  p: string;
  list: string;
  li: string;
  a: string;
}

type BlockKind = 'p' | 'ul' | 'ol';
interface Block {
  kind: BlockKind;
  lines: string[];
}

/** `[label](url)`; the URL may hold placeholders and one level of parentheses. */
const LINK = /\[([^\]\n]*)\]\(((?:\{\{[^{}]*\}\}|\([^()\s]*\)|[^()\s])*)\)/g;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const SENTINELS = /[\u0000-\u0002]/g; // eslint-disable-line no-control-regex
const VALUE_TOKEN = /\u0001(\d+)\u0001/g; // eslint-disable-line no-control-regex
const LINK_TOKEN = /\u0002(\d+)\u0002/g; // eslint-disable-line no-control-regex

function lookup(values: TemplateValues, name: string): string {
  return Object.prototype.hasOwnProperty.call(values, name)
    ? String(values[name]).replace(SENTINELS, '')
    : '';
}

/** Replaces placeholders with raw (unescaped) values. Unknown names become ''. */
export function fillPlaceholders(src: string, values: TemplateValues): string {
  return src.replace(EMAIL_PLACEHOLDER_PATTERN, (_m, name: string) =>
    lookup(values, name),
  );
}

/** Resolves a link target and returns it only when it is http(s) or mailto. */
export function resolveSafeLink(
  url: string,
  values: TemplateValues,
): string | null {
  const resolved = fillPlaceholders(url, values).trim();
  return isSafeEmailLink(resolved) ? resolved : null;
}

function splitBlocks(src: string): Block[] {
  return src
    .replace(SENTINELS, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((chunk) => chunk.split('\n').filter((l) => l.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map((lines): Block => {
      if (lines.every((l) => BULLET.test(l)))
        return { kind: 'ul', lines: lines.map((l) => l.replace(BULLET, '')) };
      if (lines.every((l) => NUMBERED.test(l)))
        return { kind: 'ol', lines: lines.map((l) => l.replace(NUMBERED, '')) };
      return { kind: 'p', lines: lines.map((l) => l.trim()) };
    });
}

type Emphasis = (inner: string, tag: 'strong' | 'em') => string;

function applyEmphasis(text: string, wrap: Emphasis): string {
  return text
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, (_m, t: string) => wrap(t, 'strong'))
    .replace(/__(?=\S)([^_]+?)__/g, (_m, t: string) => wrap(t, 'strong'))
    .replace(
      /(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g,
      (_m, pre: string, t: string) => pre + wrap(t, 'em'),
    )
    .replace(
      /(^|[^_\w])_(?=\S)([^_\n]+?)_(?!\w)/g,
      (_m, pre: string, t: string) => pre + wrap(t, 'em'),
    );
}

interface InlineMode {
  escape: (s: string) => string;
  emphasis: Emphasis;
  link: (label: string, url: string | null) => string;
}

/** Renders one inline run: links, then emphasis, then placeholder values. */
function renderInline(
  src: string,
  values: TemplateValues,
  mode: InlineMode,
  allowLinks = true,
): string {
  const links: string[] = [];
  const withoutLinks = allowLinks
    ? src.replace(LINK, (_m, label: string, url: string) => {
        const html = mode.link(
          renderInline(label, values, mode, false),
          resolveSafeLink(url, values),
        );
        links.push(html);
        return `\u0002${links.length - 1}\u0002`;
      })
    : src;
  const names: string[] = [];
  const tokenised = withoutLinks.replace(
    EMAIL_PLACEHOLDER_PATTERN,
    (_m, name: string) => {
      names.push(name);
      return `\u0001${names.length - 1}\u0001`;
    },
  );
  return applyEmphasis(mode.escape(tokenised), mode.emphasis)
    .replace(VALUE_TOKEN, (_m, i: string) =>
      mode.escape(lookup(values, names[Number(i)])),
    )
    .replace(LINK_TOKEN, (_m, i: string) => links[Number(i)]);
}

function htmlMode(styles: MarkdownStyles): InlineMode {
  return {
    escape: escapeHtml,
    emphasis: (t, tag) => `<${tag}>${t}</${tag}>`,
    link: (label, url) =>
      url
        ? `<a href="${escapeHtml(url)}" style="${styles.a}">${label}</a>`
        : label,
  };
}

const TEXT_MODE: InlineMode = {
  escape: (s) => s,
  emphasis: (t) => t,
  link: (label, url) =>
    url && url !== label ? `${label} (${url.replace(/^mailto:/i, '')})` : label,
};

/** Inline-only HTML (no paragraphs), used for one-line fields such as the footer. */
export function renderInlineHtml(
  src: string,
  values: TemplateValues,
  styles: MarkdownStyles,
): string {
  return renderInline(
    src.replace(SENTINELS, ''),
    values,
    htmlMode(styles),
  ).replace(/\r?\n/g, '<br>');
}

/** Inline-only plain text. */
export function renderInlineText(src: string, values: TemplateValues): string {
  return renderInline(src.replace(SENTINELS, ''), values, TEXT_MODE);
}

/** Renders the Markdown subset to inline-styled HTML. */
export function renderMarkdownHtml(
  src: string,
  values: TemplateValues,
  styles: MarkdownStyles,
): string {
  const mode = htmlMode(styles);
  const line = (l: string) =>
    renderInline(l, values, mode).replace(/\r?\n/g, '<br>');
  return splitBlocks(src)
    .map((b) => {
      if (b.kind === 'p')
        return `<p style="${styles.p}">${b.lines.map(line).join('<br>')}</p>`;
      const items = b.lines
        .map((l) => `<li style="${styles.li}">${line(l)}</li>`)
        .join('');
      return `<${b.kind} style="${styles.list}">${items}</${b.kind}>`;
    })
    .join('');
}

/** Renders the Markdown subset to plain text for the text/plain part. */
export function renderMarkdownText(
  src: string,
  values: TemplateValues,
): string {
  const line = (l: string) => renderInline(l, values, TEXT_MODE);
  return splitBlocks(src)
    .map((b) => {
      if (b.kind === 'p') return b.lines.map(line).join('\n');
      return b.lines
        .map((l, i) => `${b.kind === 'ul' ? '-' : `${i + 1}.`} ${line(l)}`)
        .join('\n');
    })
    .join('\n\n');
}
