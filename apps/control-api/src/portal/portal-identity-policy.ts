import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const password = z.string().min(1).max(72).refine((value) => new TextEncoder().encode(value).length <= 72);
const token = z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const portalAccountInput = z.strictObject({ email });
export const activationInput = z.strictObject({ code: token, password: password.refine((value) => value.length >= 12) });
export const loginInput = z.strictObject({ email, password });
export const portalToken = () => randomBytes(32).toString('base64url');
export const portalSessionSeconds = 28_800;

export function portalDigest(key: string, purpose: string, value: string) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update('control-portal:' + purpose).update('\0').update(value).digest('hex');
}

const prefix = '__Host-control_portal=';
export function portalCookie(header?: string) {
  const matching = header?.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith(prefix));
  if (matching?.length !== 1) return undefined;
  const parsed = token.safeParse(matching[0].slice(prefix.length));
  return parsed.success ? parsed.data : undefined;
}

export function portalSetCookie(value?: string) {
  const session = value === undefined ? '' : token.parse(value);
  return prefix + session + '; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=' + (session ? portalSessionSeconds : 0);
}

function databaseLogin(value: string | undefined) {
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

const portalConfig = z.object({
  CONTROL_PORTAL_DATABASE_URL: z.string().transform((url) => ({ url, login: databaseLogin(url) }))
    .refine(({ login }) => login !== undefined),
  CONTROL_PORTAL_AUTH_KEY: z.string().length(64).regex(/^[a-fA-F0-9]+$/),
  CONTROL_ORIGIN: z.string().refine((origin) => URL.canParse(origin) && new URL(origin).origin === origin &&
    new URL(origin).protocol === 'https:'),
});

export function readPortalConfig(env: NodeJS.ProcessEnv) {
  if (env.CONTROL_PORTAL_DATABASE_URL === undefined && env.CONTROL_PORTAL_AUTH_KEY === undefined) return undefined;
  const parsed = portalConfig.safeParse(env);
  if (!parsed.success || env.DEBUG || env.RUST_LOG || env.NODE_DEBUG) {
    throw new Error('Invalid Control portal authentication configuration');
  }
  const { CONTROL_PORTAL_DATABASE_URL: { url, login }, CONTROL_PORTAL_AUTH_KEY: key, CONTROL_ORIGIN: origin } = parsed.data;
  if (key.toLowerCase() === env.CONTROL_AUTH_KEY?.toLowerCase() ||
      [env.CONTROL_DATABASE_URL, env.CONTROL_OPERATOR_DATABASE_URL, env.CONTROL_MAIL_DATABASE_URL]
        .some((other) => databaseLogin(other) === login)) throw new Error('Invalid Control portal authentication configuration');
  return { url, key, origin };
}
