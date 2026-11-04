// Nventra POS updater (from the upstream Nodedr OrderRestro updater) — a tiny sidecar that moves the app's containers to a
// specific published version. Needed because a container can't replace itself,
// and because CasaOS pins every image to an exact version (no :latest), so
// "pull the same tag again" (Watchtower) would never find anything new.
//
//   POST /v1/update  {"version":"1.5.0"}   Authorization: Bearer <UPDATER_TOKEN>
//   GET  /v1/status                         same auth -> {state, version, error, step, rolledBackTo}
//   state: idle | pulling | restarting | done | error | rolled_back | rollback_failed
//
// Safety: it only ever touches the containers named in TARGET_CONTAINERS, and
// only swaps the *tag* of the image each one already runs (same repository),
// so it can't be pointed at an arbitrary image. Images are pulled first — if
// that fails nothing has been touched. Each container is replaced with the
// same config/network/volumes/devices and must then pass its health check;
// if any container fails to start or to become healthy, every container
// already swapped is put back on the old version and must pass its health
// check again (state `rolled_back`). If putting N back fails or N is not
// healthy either, the state is `rollback_failed`: a human has to step in.
// Data lives in volumes/bind mounts, which are never removed.
const http = require('node:http');
const crypto = require('node:crypto');

const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const TOKEN = process.env.UPDATER_TOKEN || '';
// Optional pull token for private GHCR images (read:packages). Never logged.
const GHCR_TOKEN = (process.env.GHCR_TOKEN || '').trim();
const TARGETS = (process.env.TARGET_CONTAINERS || 'nventra-pos-backend,nventra-pos-web').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 8080);
const VERSION_RE = /^\d+\.\d+\.\d+$/;


function docker(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath: SOCKET, method, path, headers: { ...extraHeaders, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          let msg = text;
          try { msg = JSON.parse(text).message || text; } catch {}
          return reject(new Error(`docker ${method} ${path.split('?')[0]} -> ${res.statusCode}: ${msg}`));
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const enc = encodeURIComponent;

function splitImage(ref) {
  // "ghcr.io/canteenx/nventra-pos-backend:1.4.0" -> repo + tag (a registry port
  // colon is before the last slash, so only a colon after it is a tag).
  const slash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', slash + 1);
  return colon === -1 ? { repo: ref, tag: 'latest' } : { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
}

// Docker Engine API X-Registry-Auth value for a GHCR image, or null when no
// token is configured or the image lives on another registry (the token must
// never be sent anywhere but ghcr.io).
function registryAuthHeader(repo, token = GHCR_TOKEN) {
  if (!token || !repo.startsWith('ghcr.io/')) return null;
  return Buffer.from(JSON.stringify({ username: 'token', password: token, serveraddress: 'ghcr.io' })).toString('base64url');
}

function redact(text, token = GHCR_TOKEN) {
  return token ? String(text).split(token).join('***') : String(text);
}

function createBody(info, image, imageEnv = []) {
  const cfg = { ...info.Config, Image: image };
  // The old container's Env also holds everything its *image* baked in (e.g.
  // APP_VERSION). Carrying those over would pin the new container to the old
  // image's values, so keep only what was set on the container itself
  // (compose / CasaOS environment).
  if (Array.isArray(cfg.Env) && imageEnv.length > 0) {
    const baked = new Set(imageEnv);
    cfg.Env = cfg.Env.filter((e) => !baked.has(e));
  }
  // An unset hostname defaults to the old container's id — don't carry that over.
  if (cfg.Hostname && info.Id.startsWith(cfg.Hostname)) delete cfg.Hostname;
  const endpoints = {};
  for (const [name, n] of Object.entries(info.NetworkSettings.Networks || {})) {
    endpoints[name] = { Aliases: (n.Aliases || []).filter((a) => !info.Id.startsWith(a)), Links: n.Links || null };
  }
  return { ...cfg, HostConfig: info.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The update engine. `docker(method, path, body, headers)` is the Engine API
// call (the real socket in production, an in-memory fake in tests).
//
// Each target is swapped to N+1 and must pass its health check: the
// container's HEALTHCHECK when it has one (compose defines them), otherwise
// "still running after graceMs". Only when ALL targets are healthy are the
// old containers and images removed. If anything fails after the first swap,
// every swapped container is put back on N — the old container itself,
// renamed back and restarted (same image, config and volumes) — and the
// status becomes `rolled_back` with the reason and the restored version.
function createUpdater({
  docker: dk,
  targets = TARGETS,
  healthTimeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 300000),
  graceMs = Number(process.env.HEALTH_GRACE_MS || 15000),
  pollMs = 1000,
}) {
  const status = { state: 'idle', version: null, error: null, step: null, rolledBackTo: null };
  const json = async (m, p, b) => { const t = await dk(m, p, b); return t ? JSON.parse(t) : null; };

  async function pull(repo, tag) {
    const auth = registryAuthHeader(repo);
    const out = await dk('POST', `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, undefined, auth ? { 'X-Registry-Auth': auth } : {});
    for (const line of String(out).split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.error) throw new Error(`pull ${repo}:${tag} failed: ${o.error}`);
    }
  }

  // Put N back under its own name and start it. A start failure throws, so
  // rollBack() reports it instead of claiming N is running.
  async function restore({ name, oldName, wasRunning, renamed }) {
    if (renamed) {
      await dk('DELETE', `/containers/${enc(name)}?force=true`).catch(() => {});
      await dk('POST', `/containers/${enc(oldName)}/rename?name=${enc(name)}`);
    }
    if (wasRunning) await dk('POST', `/containers/${enc(name)}/start`);
  }

  // Put every swapped container back on N (newest first), carrying on past
  // a failure so one bad container can't leave the others stopped, then
  // health-check what was restored. Returns the problems found (empty = OK).
  async function rollBack(swapped) {
    const problems = [];
    const restored = [];
    for (const s of [...swapped].reverse()) {
      status.step = `rolling back ${s.name}`;
      try {
        await restore(s);
        if (s.wasRunning) restored.push(s);
      } catch (err) {
        problems.push(`could not restore ${s.name}: ${redact(err.message)}`);
      }
    }
    for (const s of restored) {
      status.step = `checking ${s.name}`;
      try {
        await waitHealthy(s.name);
      } catch (err) {
        problems.push(`restored ${redact(err.message)}`);
      }
    }
    return problems;
  }

  // Stop the current container and keep it as <name>-old (until the whole
  // update is healthy), then create and start the new one with its config.
  // The container is recorded in `swapped` as soon as it is stopped, so a
  // failure anywhere after that goes through rollBack() like every other
  // container: restore errors collected, N health-checked.
  async function swap(name, newImage, swapped) {
    const info = await json('GET', `/containers/${enc(name)}/json`);
    const oldName = `${name}-old`;
    await dk('DELETE', `/containers/${enc(oldName)}?force=true`).catch(() => {}); // leftover from a failed run
    await dk('POST', `/containers/${enc(name)}/stop?t=20`);
    const record = { name, oldName, wasRunning: info.State.Running, renamed: false };
    swapped.push(record);
    await dk('POST', `/containers/${enc(name)}/rename?name=${enc(oldName)}`);
    record.renamed = true;
    const oldImage = await json('GET', `/images/${enc(info.Image)}/json`).catch(() => null);
    const created = await json('POST', `/containers/create?name=${enc(name)}`, createBody(info, newImage, oldImage?.Config?.Env ?? []));
    await dk('POST', `/containers/${enc(created.Id)}/start`);
  }

  // Containers created from an older compose file have no HEALTHCHECK, so
  // they get the grace path. With `restart: unless-stopped` a crash-looping
  // container can look Running on every poll, so any restart seen while
  // waiting (RestartCount or StartedAt changing) is a failure too.
  async function waitHealthy(name) {
    const deadline = Date.now() + healthTimeoutMs;
    let upSince = null;
    let first = null;
    for (;;) {
      const info = await json('GET', `/containers/${enc(name)}/json`);
      const st = info.State;
      const health = st.Health?.Status;
      const mark = { restarts: info.RestartCount ?? 0, startedAt: st.StartedAt ?? null };
      first ??= mark;
      if (mark.restarts !== first.restarts || mark.startedAt !== first.startedAt) {
        throw new Error(`${name} restarted during its health check (crash loop, ${mark.restarts} restarts)`);
      }
      if (!st.Running || st.Restarting) throw new Error(`${name} exited after start (exit code ${st.ExitCode ?? '?'})`);
      if (health === 'unhealthy') throw new Error(`${name} failed its health check (unhealthy)`);
      if (health === 'healthy') return;
      if (!health) {
        upSince ??= Date.now();
        if (Date.now() - upSince >= graceMs) return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${name} was not healthy within ${Math.round(healthTimeoutMs / 1000)}s (${health || 'no healthcheck'})`);
      }
      await sleep(pollMs);
    }
  }

  const fail = (message, state = 'error') => {
    console.error(state === 'error' ? 'update failed:' : 'update failed and rollback failed:', message);
    return Object.assign(status, { state, error: message, step: null });
  };

  async function run(version) {
    Object.assign(status, { state: 'pulling', version, error: null, step: 'pulling images', rolledBackTo: null });
    const plan = [];
    const swapped = [];
    try {
      for (const name of targets) {
        const info = await json('GET', `/containers/${enc(name)}/json`);
        const { repo, tag } = splitImage(info.Config.Image);
        if (tag !== version) plan.push({ name, repo, from: tag, to: version });
      }
      for (const p of plan) await pull(p.repo, p.to);
    } catch (err) {
      return fail(redact(err.message)); // nothing has been touched yet
    }
    status.state = 'restarting';
    try {
      for (const p of plan) {
        status.step = `restarting ${p.name}`;
        await swap(p.name, `${p.repo}:${p.to}`, swapped);
        status.step = `checking ${p.name}`;
        await waitHealthy(p.name);
      }
    } catch (err) {
      const message = redact(err.message);
      const problems = await rollBack(swapped);
      if (problems.length > 0) {
        return fail(`${message}; rollback failed: ${problems.join('; ')}`, 'rollback_failed');
      }
      // Compose/CasaOS installs run every target on the same tag, so the first
      // one's tag is "the version that is running again".
      const from = plan[0]?.from ?? null;
      console.error(`update to ${version} rolled back to ${from}:`, message);
      // Best-effort: drop the pulled N+1 images so repeated failed attempts
      // don't fill the disk (nothing runs them any more).
      for (const p of plan) await dk('DELETE', `/images/${enc(`${p.repo}:${p.to}`)}`).catch(() => {});
      return Object.assign(status, { state: 'rolled_back', error: message, step: null, rolledBackTo: from });
    }
    // Everything is healthy on N+1: now (and only now) drop N.
    for (const s of swapped) await dk('DELETE', `/containers/${enc(s.oldName)}`).catch(() => {});
    Object.assign(status, { state: 'done', step: null });
    for (const p of plan) await dk('DELETE', `/images/${enc(`${p.repo}:${p.from}`)}`).catch(() => {});
    return status;
  }

  return { run, status };
}

const { run, status } = createUpdater({ docker });

// This container holds the Docker socket (host root), so a guessable token
// would hand that to anything on the internal network. Values that have been
// published (the old compose defaults, upstream's and the rebrand's, and the
// CasaOS placeholder) or are too short
// to be a secret disable the updater instead.
const PUBLISHED_TOKENS = new Set([
  'nodedr-restaurant-updater',
  'nventra-pos-updater',
  'change-me-to-a-long-random-updater-token',
]);
const MIN_TOKEN_LENGTH = 24;
function tokenProblem(token) {
  if (!token) return 'UPDATER_TOKEN is not set';
  if (PUBLISHED_TOKENS.has(token)) return 'UPDATER_TOKEN is a published placeholder; set a random one (openssl rand -hex 32)';
  if (token.length < MIN_TOKEN_LENGTH) return `UPDATER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`;
  return null;
}
const TOKEN_PROBLEM = tokenProblem(TOKEN);

function authed(req) {
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
  const want = Buffer.from(TOKEN);
  return want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (TOKEN_PROBLEM) return send(503, { error: `updater disabled: ${TOKEN_PROBLEM}` });
  if (!authed(req)) return send(401, { error: 'unauthorized' });
  if (req.method === 'GET' && req.url === '/v1/status') return send(200, status);
  if (req.method === 'POST' && req.url === '/v1/update') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let version; try { version = JSON.parse(raw).version; } catch {}
      if (!VERSION_RE.test(String(version))) return send(400, { error: 'version must look like 1.2.3' });
      if (status.state === 'pulling' || status.state === 'restarting') return send(409, { error: 'update already running' });
      run(version); // runs on after this response; the app restarts underneath it
      send(202, { status: 'started', version });
    });
    return;
  }
  send(404, { error: 'not found' });
});

if (require.main === module) {
  if (TOKEN_PROBLEM) console.error(`updater disabled until fixed: ${TOKEN_PROBLEM}`);
  server.listen(PORT, () => console.log(`updater listening on :${PORT}, managing ${TARGETS.join(', ')}`));
}
module.exports = { splitImage, createBody, registryAuthHeader, redact, tokenProblem, createUpdater };
