import { PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';
import { createGmailImap } from './gmail-imap.js';
import { createGmailSmtp } from './gmail-smtp.js';
import { pollInbox } from './inbox-intake.js';
import type { EnabledMailJobConfig } from './mail-job-config.js';
import { verifyMailWorkerDatabase } from './mail-worker-database.js';
import { dispatchOutbox } from './outbox-dispatch.js';
import type { MailJobSession } from './run-mail-job.js';

type Adapters = {
  imap(env: NodeJS.ProcessEnv): Parameters<typeof pollInbox>[1];
  smtp(env: NodeJS.ProcessEnv): Parameters<typeof dispatchOutbox>[1];
};

export async function openScheduledMailWorker(config: EnabledMailJobConfig, signal: AbortSignal,
  adapters: Adapters = { imap: createGmailImap, smtp: createGmailSmtp }): Promise<MailJobSession> {
  const db = await verifyMailWorkerDatabase(new PrismaClient({ datasourceUrl: config.databaseUrl }), signal);
  const transportEnv = { CONTROL_GMAIL_USER: config.gmail.user, CONTROL_GMAIL_APP_PASSWORD: config.gmail.pass };
  return {
    async inbox(cancel) { await pollInbox(db, adapters.imap(transportEnv), cancel); },
    async outbox(cancel) { await dispatchOutbox(db, adapters.smtp(transportEnv), cancel); },
    close: () => db.$disconnect(),
  };
}
