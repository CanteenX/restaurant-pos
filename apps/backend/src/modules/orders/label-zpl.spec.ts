import { labelPrintSchema } from '@nventra/types';
import { buildZpl } from './label-zpl';

const dto = labelPrintSchema.parse({
  widthMm: 50,
  heightMm: 30,
  copies: 2,
  labels: [
    {
      title: 'Masala Chai Mix',
      price: '₹120.00',
      barcode: 'SKU12345',
      batch: 'B7',
      expiry: '2026-12-31',
    },
  ],
});

describe('buildZpl', () => {
  it('matches the golden command output', () => {
    expect(buildZpl(dto).toString('utf8')).toBe(
      [
        '^XA',
        '^PW400',
        '^LL240',
        '^CI28',
        '^FO16,16^A0N,32,32^FDMasala Chai Mix^FS',
        '^FO16,56^A0N,40,40^FD₹120.00^FS',
        '^FO16,104^A0N,24,24^FDB:B7  EXP:2026-12-31^FS',
        '^FO16,136^BCN,64,Y,N,N^FDSKU12345^FS',
        '^PQ2',
        '^XZ',
        '',
      ].join('\n'),
    );
  });

  it('strips ZPL control characters from user text', () => {
    const evil = labelPrintSchema.parse({
      labels: [{ title: 'A^FS~DG"B' }],
    });
    const s = buildZpl(evil).toString();
    expect(s).toContain('^FDA FS DG B^FS');
  });

  it('emits one format per label', () => {
    const two = labelPrintSchema.parse({
      labels: [{ title: 'a' }, { title: 'b' }],
    });
    expect(buildZpl(two).toString().match(/\^XA/g)).toHaveLength(2);
  });
});
