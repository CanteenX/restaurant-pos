// Printer-neutral label layout shared by the ZPL and TSPL generators and
// mirrored by the browser preview (apps/web/lib/label-preview.ts).
import type { LabelSpec } from '@nventra/types';

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}

export interface LabelLine {
  kind: 'text' | 'barcode';
  text: string;
  /** Dots from the left/top at 8 dots/mm (203 dpi). */
  x: number;
  y: number;
  /** Text height or barcode height in dots. */
  h: number;
}

export const DOTS_PER_MM = 8;
const MARGIN = 16;

// Strip characters that would break out of a printer command string.
export function sanitizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\^~"\\\x00-\x1f\x7f]/g, ' ').trim();
}

export function layoutLabel(spec: LabelSpec, size: LabelSize): LabelLine[] {
  const lines: LabelLine[] = [];
  let y = MARGIN;
  lines.push({
    kind: 'text',
    text: sanitizeText(spec.title),
    x: MARGIN,
    y,
    h: 32,
  });
  y += 40;
  if (spec.price) {
    lines.push({
      kind: 'text',
      text: sanitizeText(spec.price),
      x: MARGIN,
      y,
      h: 40,
    });
    y += 48;
  }
  const meta = [
    spec.batch ? `B:${spec.batch}` : '',
    spec.expiry ? `EXP:${spec.expiry}` : '',
  ]
    .filter(Boolean)
    .join('  ');
  if (meta) {
    lines.push({ kind: 'text', text: sanitizeText(meta), x: MARGIN, y, h: 24 });
    y += 32;
  }
  if (spec.barcode) {
    const bottom = size.heightMm * DOTS_PER_MM - MARGIN;
    const h = Math.max(40, Math.min(80, bottom - y - 24));
    lines.push({
      kind: 'barcode',
      text: sanitizeText(spec.barcode),
      x: MARGIN,
      y,
      h,
    });
  }
  return lines;
}
