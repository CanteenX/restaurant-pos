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
