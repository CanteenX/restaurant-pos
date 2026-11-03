import { labelPrintSchema } from '@nventra/types';
import { buildTspl } from './label-tspl';

describe('buildTspl', () => {
  it('matches the golden command output', () => {
    const dto = labelPrintSchema.parse({
      widthMm: 50,
      heightMm: 30,
      copies: 3,
      labels: [
        { title: 'Tea', price: '₹10', barcode: '123', expiry: '2027-01-02' },
      ],
    });
    expect(buildTspl(dto).toString('utf8')).toBe(
      [
        'SIZE 50 mm,30 mm',
        'GAP 2 mm,0 mm',
        'DIRECTION 1',
        'CLS',
        'TEXT 16,16,"3",0,1,1,"Tea"',
        'TEXT 16,56,"3",0,2,2,"₹10"',
        'TEXT 16,104,"3",0,1,1,"EXP:2027-01-02"',
        'BARCODE 16,136,"128",64,1,0,2,2,"123"',
        'PRINT 1,3',
        '',
      ].join('\r\n'),
    );
  });

  it('removes quotes that would end the TEXT string early', () => {
    const dto = labelPrintSchema.parse({ labels: [{ title: 'a"b' }] });
    expect(buildTspl(dto).toString()).toContain('"a b"');
  });
});
