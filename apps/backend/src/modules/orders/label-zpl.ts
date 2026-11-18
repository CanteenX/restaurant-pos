import type { LabelPrintDto } from '@nventra/types';
import { DOTS_PER_MM, layoutLabel } from './label-layout';

export function buildZpl(dto: LabelPrintDto): Buffer {
  const pw = dto.widthMm * DOTS_PER_MM;
  const ll = dto.heightMm * DOTS_PER_MM;
  const out: string[] = [];
  for (const spec of dto.labels) {
    out.push('^XA', `^PW${pw}`, `^LL${ll}`, '^CI28');
    for (const l of layoutLabel(spec, dto)) {
      if (l.kind === 'text') {
        out.push(`^FO${l.x},${l.y}^A0N,${l.h},${l.h}^FD${l.text}^FS`);
      } else {
        out.push(`^FO${l.x},${l.y}^BCN,${l.h},Y,N,N^FD${l.text}^FS`);
      }
    }
    out.push(`^PQ${dto.copies}`, '^XZ');
  }
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}
