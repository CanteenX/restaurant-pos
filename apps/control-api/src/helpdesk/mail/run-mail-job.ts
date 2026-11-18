import { z } from 'zod';
import { readMailJobConfig, type EnabledMailJobConfig } from './mail-job-config.ts';

const modeSchema = z.enum(['inbox', 'outbox']);
const runBudgetMs = 60_000;
type MailJobOutcome = 'disabled' | 'invalid-mode' | 'invalid-configuration' | 'interrupted' | 'failed' | 'complete';

export type MailJobSession = {
  inbox(signal: AbortSignal): Promise<void>;
  outbox(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
};

/** Verifies the restricted database login before returning work. Releases partial setup on failure. */
type OpenMailWorker = (config: EnabledMailJobConfig, signal: AbortSignal) => Promise<MailJobSession>;

export async function runMailJob(mode: unknown, env: NodeJS.ProcessEnv, open: OpenMailWorker,
  cancel?: AbortSignal): Promise<MailJobOutcome> {
  const parsed = modeSchema.safeParse(mode);
  if (!parsed.success) return 'invalid-mode';
  let config: ReturnType<typeof readMailJobConfig>;
  try {
    config = readMailJobConfig(env);
  } catch {
    return 'invalid-configuration';
  }
  if (!config.enabled) return 'disabled';

  const budget = AbortSignal.timeout(runBudgetMs);
  const signal = cancel ? AbortSignal.any([cancel, budget]) : budget;
  try {
    signal.throwIfAborted();
    const worker = await open(config, signal);
    try {
      signal.throwIfAborted();
      await worker[parsed.data](signal);
    } finally {
      await worker.close();
    }
    return signal.aborted ? 'interrupted' : 'complete';
  } catch {
    return signal.aborted ? 'interrupted' : 'failed';
  }
}
