import { Readable } from 'node:stream';
import { RestoreVetError } from './pg-restore-vet';
import {
  buildLoadScript,
  CopyDataExtractor,
  parseSetval,
} from './restore-load';

const COLS = new Set(['id', 'name', 'createdAt']);

async function extract(
  chunks: Buffer[],
  table = 'Order',
  cols: ReadonlySet<string> = COLS,
): Promise<{ data: Buffer; columns: string[] }> {
  const ex = new CopyDataExtractor(table, cols);
  const out: Buffer[] = [];
  ex.on('data', (d: Buffer) => out.push(d));
  await new Promise<void>((resolve, reject) => {
    ex.on('end', resolve);
    ex.on('error', reject);
    Readable.from(chunks).pipe(ex);
  });
  return { data: Buffer.concat(out), columns: ex.columns };
}

const header = (table = 'Order') =>
  [
    '\\restrict k',
    "SET client_encoding = 'UTF8';",
    `COPY public."${table}" (id, name, "createdAt") FROM stdin;`,
    '',
  ].join('\n');

const split = (b: Buffer, size: number) => {
  const parts: Buffer[] = [];
  for (let i = 0; i < b.length; i += size) parts.push(b.subarray(i, i + size));
  return parts;
};

describe('CopyDataExtractor', () => {
  it('extracts exactly the data rows and the column list', async () => {
    const src = Buffer.from(
      `${header()}1\ta\tb\n2\tc\td\n\\.\n\\unrestrict k\n`,
    );
    const { data, columns } = await extract([src]);
    expect(data.toString()).toBe('1\ta\tb\n2\tc\td\n');
    expect(columns).toEqual(['id', 'name', 'createdAt']);
  });

  it('is byte-safe for rupee and Devanagari text at every chunk size', async () => {
    const rows = '1\t₹100 कॉफ़ी\tचाय ₹५०\n2\tपनीर टिक्का\t₹250\n';
    const src = Buffer.from(`${header()}${rows}\\.\n`);
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const { data } = await extract(split(src, size));
      expect(data.toString('utf8')).toBe(rows);
    }
  });

  it.each([
    ['a \\.\\r terminator', 'x\n\\.\r\n\\! touch /tmp/pwn\n\\.\n'],
    ['a shell escape', '\\! touch /tmp/pwn\n\\.\n'],
    ['a \\copy line', "\\copy x from program 'sh'\n\\.\n"],
  ])(
    'treats %s in the data as inert data, never as a command',
    async (_n, body) => {
      const { data } = await extract([Buffer.from(`${header()}${body}`)]);
      // Whatever it is, it is only written to a data file for COPY to parse.
      expect(data).toEqual(
        Buffer.from(body.slice(0, body.lastIndexOf('\\.\n'))),
      );
    },
  );

  it('stops at the first exact \\. line and ignores everything after it', async () => {
    const src = Buffer.from(`${header()}1\ta\tb\n\\.\n\\! sh\nDROP TABLE x;\n`);
    const { data } = await extract([src]);
    expect(data.toString()).toBe('1\ta\tb\n');
  });

  it.each([
    ['another table', header('User')],
    [
      'an unknown column',
      'COPY public."Order" (id, "evil") FROM stdin;\n1\n\\.\n',
    ],
    [
      'a duplicate column',
      'COPY public."Order" (id, id) FROM stdin;\n1\n\\.\n',
    ],
    [
      'a stacked statement',
      'COPY public."Order" (id) FROM stdin; DROP TABLE x;\n\\.\n',
    ],
  ])('rejects %s in the dump COPY header', async (_n, src) => {
    await expect(extract([Buffer.from(src)])).rejects.toBeInstanceOf(
      RestoreVetError,
    );
  });

  it('rejects output that never reaches the end marker', async () => {
    await expect(
      extract([Buffer.from(`${header()}1\ta\tb\n`)]),
    ).rejects.toBeInstanceOf(RestoreVetError);
  });

  it('bounds incomplete lines before a newline arrives', async () => {
    await expect(
      extract([Buffer.alloc(8 * 1024 * 1024 + 1, 65)]),
    ).rejects.toThrow(/limit/);
  });
});

describe('parseSetval', () => {
  const seqs = new Set(['Order_id_seq']);
  it('parses a pg_restore setval for a live sequence', () => {
    const out = `\\restrict k\nSELECT pg_catalog.setval('public."Order_id_seq"', 42, true);\n`;
    expect(parseSetval(out, seqs)).toEqual({
      sequence: 'Order_id_seq',
      value: '42',
      called: true,
    });
  });
  it('preserves valid bigint counters above JavaScript safe integer range', () => {
    expect(
      parseSetval(
        'SELECT pg_catalog.setval(\'public."Order_id_seq"\', 9007199254740993, true);',
        seqs,
      ).value,
    ).toBe('9007199254740993');
  });
  it.each([
    ['SELECT pg_catalog.setval(\'public."evil_seq"\', 1, true);'],
    [
      'SELECT pg_catalog.setval(\'public."Order_id_seq"\', 1, true); DROP TABLE x;',
    ],
    ['\\! id'],
    [''],
    [
      'SELECT pg_catalog.setval(\'public."Order_id_seq"\', 9223372036854775808, true);',
    ],
  ])('rejects %j', (out) => {
    expect(() => parseSetval(out, seqs)).toThrow(RestoreVetError);
  });
});

describe('buildLoadScript', () => {
  it('contains only our text: identifiers, validated numbers and file paths', () => {
    const s = buildLoadScript({
      wipe: ['Order', 'User'],
      loads: [
        {
          table: 'User',
          columns: ['id', 'name'],
          file: '/tmp/w/User.copy',
        },
      ],
      setvals: [{ sequence: 'Order_id_seq', value: '5', called: true }],
      sequences: new Map([
        [
          'Order_id_seq',
          {
            name: 'Order_id_seq',
            table: 'Order',
            column: 'id',
            min: '1',
            max: '2147483647',
          },
        ],
      ]),
    });
    expect(s).toContain(
      [
        "SET app.sync_origin = '__skip';",
        "SET client_encoding = 'UTF8';",
        'SET search_path = pg_catalog, public;',
      ].join('\n'),
    );
    expect(s).toContain('DELETE FROM public."Order";');
    expect(s).toContain(
      '\\copy public."User" ("id", "name") FROM \'/tmp/w/User.copy\'',
    );
    expect(s).toContain('target := GREATEST(live, loaded, 5);');
    expect(s.indexOf('SET CONSTRAINTS ALL IMMEDIATE')).toBeLessThan(
      s.indexOf('pg_catalog.setval'),
    );
  });

  it('refuses a data file path that could break out of the quoting', () => {
    expect(() =>
      buildLoadScript({
        wipe: [],
        loads: [{ table: 'a', columns: ['id'], file: "/tmp/x'; \\! id; '" }],
        setvals: [],
        sequences: new Map(),
      }),
    ).toThrow(/path/i);
  });
});
