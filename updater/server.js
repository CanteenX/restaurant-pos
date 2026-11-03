// Nventra POS updater (from the upstream Nodedr OrderRestro updater) — a tiny sidecar that moves the app's containers to a
// specific published version. Needed because a container can't replace itself,
// and because CasaOS pins every image to an exact version (no :latest), so
// "pull the same tag again" (Watchtower) would never find anything new.
//
//   POST /v1/update  {"version":"1.5.0"}   Authorization: Bearer <UPDATER_TOKEN>
//   GET  /v1/status                         same auth -> {state, version, error}
//
// Safety: it only ever touches the containers named in TARGET_CONTAINERS, and
// only swaps the *tag* of the image each one already runs (same repository),
// so it can't be pointed at an arbitrary image. Images are pulled first — if
// that fails nothing has been touched. Each container is replaced with the
// same config/network/volumes/devices; on any failure the old one is put back.
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

const status = { state: 'idle', version: null, error: null, step: null };

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
const json = async (m, p, b) => { const t = await docker(m, p, b); return t ? JSON.parse(t) : null; };
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

async function pull(repo, tag) {
  const auth = registryAuthHeader(repo);
  const out = await docker('POST', `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, undefined, auth ? { 'X-Registry-Auth': auth } : {});
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.error) throw new Error(`pull ${repo}:${tag} failed: ${o.error}`);
  }
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

async function replace(name, newImage) {
  const info = await json('GET', `/containers/${enc(name)}/json`);
  const oldName = `${name}-old`;
  await docker('DELETE', `/containers/${enc(oldName)}?force=true`).catch(() => {}); // leftover from a failed run
  await docker('POST', `/containers/${enc(name)}/stop?t=20`);
  await docker('POST', `/containers/${enc(name)}/rename?name=${enc(oldName)}`);
  try {
    const oldImage = await json('GET', `/images/${enc(info.Image)}/json`).catch(() => null);
    const created = await json(
      'POST',
      `/containers/create?name=${enc(name)}`,
      createBody(info, newImage, oldImage?.Config?.Env ?? []),
    );
    await docker('POST', `/containers/${enc(created.Id)}/start`);
  } catch (err) {
    // Roll back: drop whatever was created, restore and restart the old one.
    await docker('DELETE', `/containers/${enc(name)}?force=true`).catch(() => {});
    await docker('POST', `/containers/${enc(oldName)}/rename?name=${enc(name)}`);
    if (info.State.Running) await docker('POST', `/containers/${enc(name)}/start`).catch(() => {});
    throw err;
  }
  await docker('DELETE', `/containers/${enc(oldName)}`).catch(() => {});
}

async function run(version) {
  Object.assign(status, { state: 'pulling', version, error: null, step: 'pulling images' });
  try {
    const plan = [];
    for (const name of TARGETS) {
      const info = await json('GET', `/containers/${enc(name)}/json`);
      const { repo, tag } = splitImage(info.Config.Image);
      plan.push({ name, repo, from: tag, to: version });
    }
    for (const p of plan) await pull(p.repo, p.to);
    status.state = 'restarting';
    const done = [];
    for (const p of plan) {
      if (p.from === p.to) continue;
      status.step = `restarting ${p.name}`;
      await replace(p.name, `${p.repo}:${p.to}`);
      done.push(p);
    }
    Object.assign(status, { state: 'done', step: null });
    // Best-effort cleanup of the superseded images so disks don't fill up.
    for (const p of done) await docker('DELETE', `/images/${enc(`${p.repo}:${p.from}`)}`).catch(() => {});
  } catch (err) {
    const message = redact(err.message);
    console.error('update failed:', message);
    Object.assign(status, { state: 'error', error: message, step: null });
  }
}

// This container holds the Docker socket (host root), so a guessable token
// would hand that to anything on the internal network. Values that have been
// published (the old compose default, the CasaOS placeholder) or are too short
// to be a secret disable the updater instead.
const PUBLISHED_TOKENS = new Set(['nodedr-restaurant-updater', 'change-me-to-a-long-random-updater-token']);
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
  return given.length === want.length && crypto.timingSafeEqual(given, want);
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
module.exports = { splitImage, createBody, registryAuthHeader, redact, tokenProblem };
