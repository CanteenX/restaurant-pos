import { z } from 'zod';
import { readGmailConfig } from './gmail-config.ts';

const enabled = z.enum(['true', 'false']).default('false');
const positiveDays = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

function postgresIdentity(value: string | undefined) {
  if (!value || /[\s\\#]/u.test(value) || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username ||
      !/^\/[^/]+$/.test(url.pathname) || url.port === '0') return undefined;
  try {
    return JSON.stringify([decodeURIComponent(url.username), url.hostname.toLowerCase(),
      url.port || '5432', decodeURIComponent(url.pathname.slice(1))]);
  } catch {
    return undefined;
  }
}

const settings = z.object({
  CONTROL_MAIL_DATABASE_URL: z.string().transform((url) => ({ url, identity: postgresIdentity(url) }))
    .refine(({ identity }) => identity !== undefined),
  CONTROL_MAIL_RETENTION_DAYS: positiveDays,
});

export type EnabledMailJobConfig = {
  enabled: true;
  databaseUrl: string;
  retentionDays: number;
  gmail: ReturnType<typeof readGmailConfig>;
};

function invalid(): never {
  throw new Error('Invalid Control mail job configuration');
}

export function readMailJobConfig(env: NodeJS.ProcessEnv): EnabledMailJobConfig | { enabled: false } {
  const activation = enabled.safeParse(env.CONTROL_MAIL_ENABLED);
  if (!activation.success) invalid();
  if (activation.data === 'false') return { enabled: false };

  const config = settings.safeParse(env);
  if (!config.success) invalid();
  const { CONTROL_MAIL_DATABASE_URL: { url: databaseUrl, identity }, CONTROL_MAIL_RETENTION_DAYS: retentionDays } = config.data;
  if ([env.CONTROL_DATABASE_URL, env.CONTROL_OPERATOR_DATABASE_URL].some((url) => postgresIdentity(url) === identity)) invalid();
  try {
    return { enabled: true, databaseUrl, retentionDays, gmail: readGmailConfig(env) };
  } catch {
    invalid();
  }
}
