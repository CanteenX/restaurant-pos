import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { loadVettedData, LoadOptions } from './restore-load';
import { runPg } from './pg-run';

let payload = Buffer.alloc(0);
let failSpawn = false;
const kills = jest.fn();
jest.mock('./pg-run', () => ({ runPg: jest.fn().mockResolvedValue('') }));
jest.mock('node:child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: kills,
    });
    process.nextTick(() => {
      if (failSpawn) {
        child.emit('error', new Error('spawn pg_restore ENOENT'));
        child.stdout.destroy();
      } else {
        child.stdout.end(payload);
      }
      child.emit('close', failSpawn ? 1 : 0);
    });
    return child;
  },
}));

describe('loadVettedData process boundary', () => {
  let options: LoadOptions;
  beforeEach(async () => {
    const workDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'restore-load-run-'),
    );
    options = {
      file: path.join(workDir, 'db.dump'),
      workDir,
      entries: ['1; 0 1 TABLE DATA public Order app'],
      url: 'postgresql://app:fixture@db/app',
      wipe: ['Order'],
      columnsByTable: new Map([['Order', new Set(['name'])]]),
      sequences: new Map(),
    };
    await fs.writeFile(options.file, 'synthetic compressed archive');
    failSpawn = false;
    jest.mocked(runPg).mockClear();
    kills.mockClear();
    payload = Buffer.from(
      'COPY public."Order" (name) FROM stdin;\n₹१०० चाय\n\\.\n\\! bad\n',
    );
  });
  afterEach(async () => {
    await fs.rm(options.workDir, { recursive: true, force: true });
  });

  it('puts only raw row bytes in the data file and only generated commands in psql', async () => {
    await loadVettedData(options);
    expect(
      await fs.readFile(path.join(options.workDir, 'data-0.copy')),
    ).toEqual(Buffer.from('₹१०० चाय\n'));
    const script = await fs.readFile(
      path.join(options.workDir, 'load.sql'),
      'utf8',
    );
    expect(script).toContain('\\copy public."Order" ("name") FROM');
    expect(script).not.toContain('\\!');
    expect(script).not.toContain('₹१०० चाय');
    expect(runPg).toHaveBeenCalledTimes(1);
    expect(jest.mocked(runPg).mock.calls[0].slice(0, 2)).toEqual([
      'psql',
      [
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '--single-transaction',
        '-f',
        path.join(options.workDir, 'load.sql'),
      ],
    ]);
  });

  it('never starts a destructive psql operation after an unsafe COPY header', async () => {
    payload = Buffer.from(
      'COPY public."Order" (name) FROM PROGRAM \'bad\';\n\\.\n',
    );
    await expect(loadVettedData(options)).rejects.toThrow(/incomplete/);
    expect(runPg).not.toHaveBeenCalled();
    expect(kills).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects a configured aggregate budget before destructive load', async () => {
    process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES = '10';
    try {
      await expect(loadVettedData(options)).rejects.toThrow(
        /NVENTRA_RESTORE_MAX_OUTPUT_BYTES/,
      );
      expect(runPg).not.toHaveBeenCalled();
    } finally {
      delete process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES;
    }
  });

  it('counts metadata as well as rows across extraction processes', async () => {
    options.entries = [...options.entries, ...options.entries];
    process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES = String(
      payload.length * 2 - 1,
    );
    try {
      await expect(loadVettedData(options)).rejects.toThrow(
        /NVENTRA_RESTORE_MAX_OUTPUT_BYTES/,
      );
      expect(runPg).not.toHaveBeenCalled();
    } finally {
      delete process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES;
    }
  });

  it('includes sequence output in the aggregate budget', async () => {
    options.entries = ['1; 0 0 SEQUENCE SET public Order_id_seq app'];
    options.sequences = new Map([
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
    ]);
    jest
      .mocked(runPg)
      .mockResolvedValueOnce(
        "SELECT pg_catalog.setval('public.Order_id_seq', 1, true);",
      );
    process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES = '10';
    try {
      await expect(loadVettedData(options)).rejects.toThrow(
        /NVENTRA_RESTORE_MAX_OUTPUT_BYTES/,
      );
      expect(
        jest.mocked(runPg).mock.calls.some(([cmd]) => cmd === 'psql'),
      ).toBe(false);
    } finally {
      delete process.env.NVENTRA_RESTORE_MAX_OUTPUT_BYTES;
    }
  });

  it('handles a missing pg_restore executable without an unhandled child error', async () => {
    failSpawn = true;
    await expect(loadVettedData(options)).rejects.toThrow();
    expect(runPg).not.toHaveBeenCalled();
  });
});
