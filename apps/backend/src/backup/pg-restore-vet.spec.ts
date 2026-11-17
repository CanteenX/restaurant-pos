import { RestoreVetError, selectDataEntries } from './pg-restore-vet';

const TABLES = new Set(['Order', 'User']);
const DATA = '3345; 0 16400 TABLE DATA public Order nventra';
const SEQ = '3346; 0 0 SEQUENCE SET public Order_id_seq nventra';

const HOSTILE_SCHEMA_ENTRIES = [
  '2; 3079 16385 EXTENSION - adminpack',
  '5; 1255 16999 FUNCTION public s(cstring) nventra',
  '6; 2620 17000 TRIGGER public Order evil nventra',
  '7; 1260 16999 ROLE - backdoor',
  '8; 0 0 ACL public TABLE Order nventra',
  '9; 0 0 COMMENT - EXTENSION pgcrypto',
  '10; 1259 16400 TABLE public Order nventra',
  '11; 2606 16401 FK CONSTRAINT public Order fk nventra',
];

describe('selectDataEntries', () => {
  it('keeps only table data and sequence sets for app tables', () => {
    const toc = [...HOSTILE_SCHEMA_ENTRIES, DATA, SEQ].join('\n');
    expect(selectDataEntries(toc, TABLES)).toEqual([DATA, SEQ]);
  });

  it('skips _prisma_migrations data instead of restoring it', () => {
    const toc = [
      DATA,
      '3347; 0 16410 TABLE DATA public _prisma_migrations nventra',
    ].join('\n');
    expect(selectDataEntries(toc, TABLES)).toEqual([DATA]);
  });

  it.each([
    ['unknown table', '3348; 0 16500 TABLE DATA public pg_authid nventra'],
    ['other schema', '3348; 0 16500 TABLE DATA evil Order nventra'],
    ['unknown sequence', '3348; 0 0 SEQUENCE SET public secrets_seq nventra'],
  ])('rejects data for %s', (_n, line) => {
    expect(() => selectDataEntries(`${DATA}\n${line}`, TABLES)).toThrow(
      RestoreVetError,
    );
  });

  it('fails closed on an empty TOC or one without table data', () => {
    expect(() => selectDataEntries('', TABLES)).toThrow(/empty|unreadable/);
    expect(() =>
      selectDataEntries(HOSTILE_SCHEMA_ENTRIES.join('\n'), TABLES),
    ).toThrow(/no table data/);
  });
});
