/**
 * Keeps the database password out of child-process argv and out of anything
 * a backup failure stores, returns or notifies (issue #29 review).
 *
 * Node's execFile error message is `Command failed: <cmd> <args…>`, so a
 * connection URL passed as an argument ends up in every error. Instead the
 * URL is split into libpq env vars (PGPASSWORD etc.), and every message is
 * passed through redactSecrets before it leaves the service.
 */

/** Prisma-only query params that libpq would reject. */
const IGNORED_PARAMS = new Set(['schema', 'connection_limit', 'pool_timeout']);
const PARAM_ENV: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  application_name: 'PGAPPNAME',
};

export function pgEnvFromUrl(url: string | undefined): Record<string, string> {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    throw new Error('DATABASE_URL is missing or not a valid URL');
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must be a postgres:// URL');
  }
  const env: Record<string, string> = {};
  const set = (k: string, v: string) => {
    if (v) env[k] = v;
  };
  set('PGHOST', decodeURIComponent(u.hostname).replace(/^\[|\]$/g, ''));
  set('PGPORT', u.port);
  set('PGUSER', decodeURIComponent(u.username));
  set('PGPASSWORD', decodeURIComponent(u.password));
  set('PGDATABASE', decodeURIComponent(u.pathname.replace(/^\//, '')));
  for (const [key, value] of u.searchParams) {
    if (IGNORED_PARAMS.has(key)) continue;
    if (PARAM_ENV[key]) set(PARAM_ENV[key], value);
  }
  return env;
}

/** Masks `scheme://user:pass@`, `PASSWORD=…` and any explicitly known secret. */
export function redactSecrets(message: string, known: string[] = []): string {
  let out = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@]*@/gi, '$1:***@')
    .replace(/(PASSWORD\s*=\s*)\S+/gi, '$1***');
  for (const secret of known) {
    if (secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

/** Describes a failed execFile call from its stderr, not its argv. */
export function describeExecError(cmd: string, err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr =
    typeof e?.stderr === 'string'
      ? e.stderr.trim()
      : Buffer.isBuffer(e?.stderr)
        ? e.stderr.toString('utf8').trim()
        : '';
  const detail = stderr || String(e?.message ?? err);
  return `${cmd} failed: ${detail}`;
}

/** Secrets worth masking by value: the DB password, raw and URL-encoded. */
export function knownDbSecrets(url: string | undefined): string[] {
  try {
    const u = new URL(url ?? '');
    return u.password ? [u.password, decodeURIComponent(u.password)] : [];
  } catch {
    return [];
  }
}
