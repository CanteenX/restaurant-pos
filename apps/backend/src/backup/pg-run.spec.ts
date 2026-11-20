import { runPg } from './pg-run';
const buffers: number[] = [];
let failBudget = false;
jest.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    opts: { maxBuffer: number },
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    buffers.push(opts.maxBuffer);
    cb(
      failBudget
        ? Object.assign(new Error('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          })
        : null,
      { stdout: '', stderr: '' },
    );
  },
}));
it('enforces a caller output budget without increasing the default ceiling', async () => {
  await runPg('pg_restore', [], 'postgresql://fixture@db/app', 128);
  await runPg('pg_restore', [], 'postgresql://fixture@db/app', 128 * 1024 ** 2);
  expect(buffers).toEqual([128, 64 * 1024 ** 2]);
});

it('preserves the safe output-limit error code for caller guidance', async () => {
  failBudget = true;
  try {
    await expect(
      runPg('pg_restore', [], 'postgresql://fixture@db/app', 128),
    ).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  } finally {
    failBudget = false;
  }
});
