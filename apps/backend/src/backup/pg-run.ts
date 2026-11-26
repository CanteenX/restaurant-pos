import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  describeExecError,
  knownDbSecrets,
  pgEnvFromUrl,
  redactSecrets,
} from './pg-env';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

export type PgBinary = 'pg_dump' | 'pg_restore' | 'psql';

/** Runs a pg client binary with credentials in env (never argv) and a redacted error. */
export async function runPg(
  cmd: PgBinary,
  args: string[],
  url: string | undefined,
  outputBudget = MAX_BUFFER,
): Promise<string> {
  const env = { ...process.env, ...pgEnvFromUrl(url) };
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env,
      maxBuffer: Math.min(MAX_BUFFER, outputBudget),
    });
    return String(stdout);
  } catch (err) {
    const msg = redactSecrets(describeExecError(cmd, err), knownDbSecrets(url));
    const failure = new Error(
      msg.length > MAX_ERROR_CHARS
        ? `${msg.slice(0, MAX_ERROR_CHARS)}...`
        : msg,
    );
    if (
      (err as { code?: unknown })?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw Object.assign(failure, {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
    }
    throw failure;
  }
}

/** One-shot query returning unaligned, tuples-only text. */
export const psqlQuery = (sql: string, url: string | undefined) =>
  runPg(
    'psql',
    ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    url,
  );
