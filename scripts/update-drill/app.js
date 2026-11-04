// Stand-in app for scripts/update-rollback-drill.sh: a tiny HTTP server that
// keeps its data in /data (a volume, like the real backend's database/uploads)
// and reports the version baked into its image. BROKEN=1 images fail /health.
const http = require('node:http');
const fs = require('node:fs');

const FILE = '/data/notes.json';
const VERSION = process.env.APP_VERSION || 'dev';
const BROKEN = process.env.BROKEN === '1';
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };

http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health') return BROKEN ? send(500, { status: 'broken' }) : send(200, { status: 'ok' });
  if (req.url === '/version') return send(200, { version: VERSION });
  if (req.url === '/notes' && req.method === 'GET') return send(200, read());
  if (req.url === '/notes' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { const notes = [...read(), raw]; fs.writeFileSync(FILE, JSON.stringify(notes)); send(201, notes); });
    return;
  }
  send(404, { error: 'not found' });
}).listen(4000);
