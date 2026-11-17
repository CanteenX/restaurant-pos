import { parseSequences, sequencePreflight } from './restore-sequences';

const ROW = 'sync_changes_seq_seq|sync_changes|seq|1|9223372036854775807|1|f';

describe('live sequence validation', () => {
  it('preserves bigint bounds without rounding them through JavaScript Number', () => {
    expect(parseSequences(ROW).get('sync_changes_seq_seq')?.max).toBe(
      '9223372036854775807',
    );
    expect(() =>
      sequencePreflight(parseSequences(ROW), [
        {
          sequence: 'sync_changes_seq_seq',
          value: '9007199254740993',
          called: true,
        },
      ]),
    ).not.toThrow();
  });

  it.each([
    ROW.replace('|1|f', '|-1|f'),
    ROW.replace('|1|f', '|1|t'),
    ROW.replace('|sync_changes|', '|?|'),
    ROW.replace('|1|9223372036854775807|', '|5|1|'),
    `${ROW}\n${ROW}`,
  ])('fails closed for unsupported or ambiguous catalog metadata', (row) => {
    expect(() => parseSequences(row)).toThrow();
  });

  it('checks every value before constructing a destructive script', () => {
    const sequences = parseSequences(ROW);
    expect(() =>
      sequencePreflight(sequences, [
        { sequence: 'sync_changes_seq_seq', value: '42', called: true },
        { sequence: 'sync_changes_seq_seq', value: '0', called: true },
      ]),
    ).toThrow(/out of range/);
    expect(() =>
      sequencePreflight(sequences, [
        { sequence: 'fake', value: '42', called: true },
      ]),
    ).toThrow(/out of range/);
  });
});
