import { z } from 'zod';

const gmailConfigSchema = z.object({
  CONTROL_GMAIL_USER: z.string().max(254).pipe(z.email()),
  CONTROL_GMAIL_APP_PASSWORD: z.string().regex(/^[A-Za-z0-9]{16}$/),
});

export function readGmailConfig(env: NodeJS.ProcessEnv) {
  const result = gmailConfigSchema.safeParse(env);
  if (!result.success) throw new Error('Invalid Gmail transport configuration');
  return {
    user: result.data.CONTROL_GMAIL_USER,
    pass: result.data.CONTROL_GMAIL_APP_PASSWORD,
  };
}
