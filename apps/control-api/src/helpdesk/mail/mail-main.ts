function fail(reason = 'failed') {
  process.stderr.write('Control mail job did not complete (' + reason + ').\n');
  process.exitCode = 1;
}

async function main() {
  if (process.env.DEBUG || process.env.RUST_LOG || process.env.NODE_DEBUG) {
    fail('invalid-configuration');
    return;
  }
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const mode = process.argv.length === 3 ? process.argv[2] : undefined;
    const { runMailJob } = await import('./run-mail-job.js');
    const result = await runMailJob(mode, process.env, async (config, signal) => {
      const { openScheduledMailWorker } = await import('./scheduled-mail-worker.js');
      return openScheduledMailWorker(config, signal);
    }, cancel.signal);
    if (result !== 'complete' && result !== 'disabled') fail(result);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

void main().catch(() => fail());
