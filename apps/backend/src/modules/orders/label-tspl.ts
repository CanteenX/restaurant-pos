import type { LabelPrintDto } from '@nventra/types';
import { layoutLabel } from './label-layout';

export function buildTspl(dto: LabelPrintDto): Buffer {
  const out: string[] = [];
  for (const spec of dto.labels) {
    out.push(
      `SIZE ${dto.widthMm} mm,${dto.heightMm} mm`,
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'CLS',
    );
    for (const l of layoutLabel(spec, dto)) {
      if (l.kind === 'text') {
        const mult = Math.max(1, Math.round(l.h / 24));
        out.push(`TEXT ${l.x},${l.y},"3",0,${mult},${mult},"${l.text}"`);
      } else {
        out.push(`BARCODE ${l.x},${l.y},"128",${l.h},1,0,2,2,"${l.text}"`);
      }
    }
    out.push(`PRINT 1,${dto.copies}`);
  }
  return Buffer.from(out.join('\r\n') + '\r\n', 'utf8');
}
