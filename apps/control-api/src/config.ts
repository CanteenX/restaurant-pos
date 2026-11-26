import { z } from 'zod';

const controlConfigSchema = z.object({
  CONTROL_API_PORT: z
    .string()
    .regex(/^[0-9]{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535)),
});

export function readControlPort(env: NodeJS.ProcessEnv): number {
  const result = controlConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error('Invalid Control API configuration: CONTROL_API_PORT');
  }

  return result.data.CONTROL_API_PORT;
}

export function readStaffConfig(env: NodeJS.ProcessEnv) {
  const { CONTROL_DATABASE_URL: url, CONTROL_AUTH_KEY: key, CONTROL_ORIGIN: origin } = env;
  if ([url, key, origin].every((s) => s === undefined)) return undefined;
  if (!url || !URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol) ||
      !key || !/^[a-fA-F0-9]{64}$/.test(key) || !origin || !URL.canParse(origin) ||
      new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') {
    throw new Error('Invalid Control staff authentication configuration');
  }
  return { url, key, origin };
}
