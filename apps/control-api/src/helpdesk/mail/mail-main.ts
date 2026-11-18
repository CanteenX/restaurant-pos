import { runMailJob } from './run-mail-job.js';
import { openScheduledMailWorker } from './scheduled-mail-worker.js';

function fail(reason = 'failed') {
  process.stderr.write('Control mail job did not complete (' + reason + ').\n');
  process.exitCode = 1;
}

async function main() {
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const mode = process.argv.length === 3 ? process.argv[2] : undefined;
    const result = await runMailJob(mode, process.env, openScheduledMailWorker, cancel.signal);
    if (result !== 'complete' && result !== 'disabled') fail(result);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

void main().catch(() => fail());
