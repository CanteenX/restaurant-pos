// In-memory stand-in for the Docker Engine API, used by server.test.js only.
// `health(image, name)` decides how a container started from `image` behaves:
// 'healthy' | 'unhealthy' | 'starting' | 'running' (no healthcheck) | 'exits' | 'fail-start'
// | 'completed' (successful one-shot) | 'crashloop' (restarted on every inspect).
// Set `fd.failRename = (from, to) => bool` to make a rename fail.
function fakeDocker({ health = () => 'healthy', images = [] } = {}) {
  const containers = new Map();
  const imageSet = new Set(images);
  const log = [];
  let seq = 0;
  const err = (code, msg) => Object.assign(new Error(`docker -> ${code}: ${msg}`), { statusCode: code });

  function stateFor(c) {
    const h = health(c._image, c.Name.slice(1));
    const StartedAt = `t${c._starts}`;
    if (!c._running) return { Running: false, Restarting: false, ExitCode: 0, StartedAt };
    if (h === 'exits') return { Running: false, Restarting: false, ExitCode: 1, StartedAt };
    if (h === 'completed') return { Running: false, Restarting: false, ExitCode: 0, StartedAt };
    if (h === 'running') return { Running: true, Restarting: false, ExitCode: 0, StartedAt };
    if (h === 'crashloop') {
      c._restarts += 1; c._starts += 1; // crashed and restarted since the last look
      return { Running: true, Restarting: false, ExitCode: 0, StartedAt: `t${c._starts}` };
    }
    return { Running: true, Restarting: false, ExitCode: 0, StartedAt, Health: { Status: h } };
  }

  function add(name, image, running = true) {
    const Id = `${(++seq).toString(16).padStart(12, '0')}deadbeef`;
    containers.set(name, {
      Id, Name: `/${name}`, Image: `sha256:${image}`, _image: image, _running: running, _restarts: 0, _starts: 0,
      Config: { Image: image, Env: ['APP=1'], Hostname: Id.slice(0, 12) },
      HostConfig: { Binds: ['data:/data'] },
      NetworkSettings: { Networks: { net: { Aliases: [name, Id.slice(0, 12)] } } },
    });
    imageSet.add(image);
    return Id;
  }

  function find(ref) {
    if (containers.has(ref)) return [ref, containers.get(ref)];
    for (const [n, c] of containers) if (c.Id === ref) return [n, c];
    return [null, null];
  }

  function view(c) {
    const State = stateFor(c);
    return { ...c, RestartCount: c._restarts, State };
  }

  async function docker(method, path, body) {
    const [p, qs] = path.split('?');
    const q = new URLSearchParams(qs || '');
    const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
    log.push(`${method} ${p}${q.get('name') ? `?name=${q.get('name')}` : ''}`);
    if (parts[0] === 'images') {
      if (parts[1] === 'create') {
        const ref = `${q.get('fromImage')}:${q.get('tag')}`;
        if (!imageSet.has(ref)) return JSON.stringify({ error: `manifest for ${ref} not found` });
        return JSON.stringify({ status: 'ok' });
      }
      const ref = parts.slice(1, -1).join('/') || parts[1];
      if (method === 'GET') return JSON.stringify({ Config: { Env: ['BAKED=1'] }, ref });
      if (method === 'DELETE') { imageSet.delete(parts.slice(1).join('/')); return '[]'; }
    }
    if (parts[0] === 'containers') {
      if (parts[1] === 'create') {
        const name = q.get('name');
        if (containers.has(name)) throw err(409, 'name in use');
        const Id = add(name, body.Image, false);
        containers.get(name).Config = { ...body };
        return JSON.stringify({ Id });
      }
      const [name, c] = find(parts[1]);
      if (!c) throw err(404, `No such container: ${parts[1]}`);
      const action = parts[2];
      if (method === 'GET' && action === 'json') return JSON.stringify(view(c));
      if (method === 'DELETE') { if (c._running && q.get('force') !== 'true') throw err(409, 'running'); containers.delete(name); return ''; }
      if (action === 'stop') { c._running = false; return ''; }
      if (action === 'start') {
        if (health(c._image, name) === 'fail-start') throw err(500, 'start failed');
        c._running = true; c._starts += 1; return '';
      }
      if (action === 'rename') {
        const to = q.get('name');
        if (containers.has(to)) throw err(409, 'name in use');
        if (api.failRename?.(name, to)) throw err(500, `rename ${name} failed`);
        containers.delete(name); c.Name = `/${to}`; containers.set(to, c); return '';
      }
    }
    throw err(404, `unhandled ${method} ${path}`);
  }

  const api = { docker, add, containers, imageSet, log, failRename: null, imageOf: (n) => containers.get(n)?._image, running: (n) => !!containers.get(n)?._running };
  return api;
}

module.exports = { fakeDocker };
