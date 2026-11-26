import { Readable } from 'node:stream';
import { RestoreVetError } from './pg-restore-vet';
import {
  buildLoadScript,
  CopyDataExtractor,
  parseSetval,
  restoreLimits,
} from './restore-load';

const COLS = new Set(['id', 'name', 'createdAt']);

async function extract(
  chunks: Buffer[],
  table = 'Order',
  cols: ReadonlySet<string> = COLS,
  limits?: ReturnType<typeof restoreLimits>,
): Promise<{ data: Buffer; columns: string[] }> {
  const ex = new CopyDataExtractor(table, cols, limits);
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
    expect(s).toContain("SET LOCAL lock_timeout = '10000ms';");
    expect(s).toContain("SET LOCAL statement_timeout = '900000ms';");
    expect(s.indexOf('lock_timeout')).toBeLessThan(s.indexOf('LOCK TABLE'));
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

describe('restore size policy', () => {
  it('sizes decompression budget from compressed archive size, bounded by a ceiling', () => {
    expect(restoreLimits(16 * 1024 * 1024, {}).outputBytes).toBe(2 * 1024 ** 3);
    expect(restoreLimits(1024 ** 3, {}).outputBytes).toBe(16 * 1024 ** 3);
  });
  it('uses explicit limits for highly compressible legitimate data', () => {
    expect(
      restoreLimits(100, {
        NVENTRA_RESTORE_MAX_OUTPUT_BYTES: '4096',
        NVENTRA_RESTORE_MAX_LINE_BYTES: '512',
      }),
    ).toEqual({ outputBytes: 4096, lineBytes: 512 });
  });
  it.each(['0', '-1', 'NaN', '1.5', '9007199254740992'])(
    'refuses invalid configured ceilings %s',
    (value) => {
      expect(() =>
        restoreLimits(100, { NVENTRA_RESTORE_MAX_OUTPUT_BYTES: value }),
      ).toThrow(/NVENTRA_RESTORE_MAX_OUTPUT_BYTES/);
    },
  );
  it('refuses excessive compressed archives before extraction', () => {
    expect(() =>
      restoreLimits(4097, { NVENTRA_RESTORE_MAX_ARCHIVE_BYTES: '4096' }),
    ).toThrow(/NVENTRA_RESTORE_MAX_ARCHIVE_BYTES/);
  });
});

describe('configured COPY stream budgets (supplemental)', () => {
  it('accepts a legitimate row above the old 8 MiB limit', async () => {
    const row = 'x'.repeat(8 * 1024 ** 2 + 1);
    const data = await extract(
      [Buffer.from(`${header()}${row}\n\\.\n`)],
      'Order',
      COLS,
      restoreLimits(100),
    );
    expect(data.data.length).toBe(row.length + 1);
  });
  it('accepts a row exactly at the configured line boundary', async () => {
    const result = await extract(
      [Buffer.from(`${header()}${'x'.repeat(64)}\n\\.\n`)],
      'Order',
      COLS,
      { lineBytes: 64, outputBytes: 1024 },
    );
    expect(result.data.length).toBe(65);
  });
  it('rejects split and complete lines above a configured boundary', async () => {
    for (const chunks of [
      [Buffer.alloc(65, 65)],
      [Buffer.alloc(65, 65), Buffer.from('\n')],
    ]) {
      await expect(
        extract(chunks, 'Order', COLS, { lineBytes: 64, outputBytes: 1000 }),
      ).rejects.toThrow(/NVENTRA_RESTORE_MAX_LINE_BYTES/);
    }
  });
});

describe('COPY incremental allocation', () => {
  it('copies fragmented rows in linear total bytes', async () => {
    const row = Buffer.from(`${header()}${'x'.repeat(128 * 1024)}\n\\.\n`);
    const real = Buffer.concat.bind(Buffer) as typeof Buffer.concat;
    let copied = 0;
    const spy = jest
      .spyOn(Buffer, 'concat')
      .mockImplementation((parts, length) => {
        copied += length ?? parts.reduce((sum, part) => sum + part.length, 0);
        return real(parts, length);
      });
    try {
      await extract(split(row, 1024));
      expect(copied <= row.length * 4).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
