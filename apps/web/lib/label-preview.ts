// Browser preview of a label: same layout as the printer command generators
// (apps/backend/src/modules/orders/label-layout.ts), 8 dots per mm.
import type { LabelSpec } from "@nventra/types";

export const DOTS_PER_MM = 8;
const MARGIN = 16;

export interface PreviewItem {
  kind: "text" | "barcode";
  text: string;
  x: number;
  y: number;
  h: number;
}

export function previewLayout(spec: LabelSpec, heightMm: number): PreviewItem[] {
  const items: PreviewItem[] = [];
  let y = MARGIN;
  items.push({ kind: "text", text: spec.title, x: MARGIN, y, h: 32 });
  y += 40;
  if (spec.price) {
    items.push({ kind: "text", text: spec.price, x: MARGIN, y, h: 40 });
    y += 48;
  }
  const meta = [spec.batch ? `B:${spec.batch}` : "", spec.expiry ? `EXP:${spec.expiry}` : ""]
    .filter(Boolean)
    .join("  ");
  if (meta) {
    items.push({ kind: "text", text: meta, x: MARGIN, y, h: 24 });
    y += 32;
  }
  if (spec.barcode) {
    const bottom = heightMm * DOTS_PER_MM - MARGIN;
    const h = Math.max(40, Math.min(80, bottom - y - 24));
    items.push({ kind: "barcode", text: spec.barcode, x: MARGIN, y, h });
  }
  return items;
}
