import express from 'express';
import WebTorrent from 'webtorrent';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, stat, unlink, access, constants as fsc } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto, { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DL_DATA || root; // where config.json lives
const BIN_DIR = process.env.DL_BIN || path.join(root, 'bin');
const YTDLP = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const HOST = process.env.DL_HOST || '127.0.0.1'; // set DL_HOST=0.0.0.0 to allow other devices on your Wi-Fi (PIN required)
const PUBLIC_DIR = process.env.DL_PUBLIC || path.join(root, 'public');
const FFMPEG = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep); // packaged Electron app
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_DOWNLOADS = process.env.DL_DOWNLOADS || path.join(root, 'downloads');

// ---------- settings (saved download folder) ----------
let config = {};
try { config = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
let DOWNLOADS = path.resolve(config.downloadDir || DEFAULT_DOWNLOADS);
try { await mkdir(DOWNLOADS, { recursive: true }); }
catch { DOWNLOADS = path.resolve(DEFAULT_DOWNLOADS); await mkdir(DOWNLOADS, { recursive: true }); }

const saveConfig = () => writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));

// ---------- access control ----------
// "Local" = the person sitting at this PC (Electron window / localhost browser tab).
// Tunnels (cloudflared, tailscale) also connect from loopback, so forwarding headers, a foreign Host
// (DNS rebinding) or a foreign Origin (another website's page) all make a request NON-local.
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'tailscale-user-login'];
function isLocal(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (FORWARD_HEADERS.some((h) => req.headers[h])) return false;
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; } }
  return true;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newPin = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.randomBytes(8), (b) => a[b % a.length]).join(''); };
const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
const hasValidToken = (req) => { const t = tokenOf(req); return !!t && (config.tokens || []).includes(sha(t)); };
const authed = (req) => isLocal(req) || hasValidToken(req);

// PIN: set DL_PIN on a server (min 8 chars); otherwise one is generated and kept in config.json
const PIN_FROM_ENV = !!process.env.DL_PIN;
if (PIN_FROM_ENV) {
  const p = process.env.DL_PIN.trim().toUpperCase().replace(/[\s-]/g, '');
  if (p.length < 8) throw new Error('DL_PIN must be at least 8 characters');
  config.pin = p;
} else if (!config.pin) { config.pin = newPin(); await saveConfig(); }
config.tokens ||= [];

// Login throttling: 10 wrong PINs per client IP per 10 min, and 100 across everyone (distributed guessing).
const clientIp = (req) => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
const failedByIp = new Map(); let failedAll = [];
const recent = (list, now) => list.filter((t) => now - t < 600000);

// Optional SSRF guard for servers (DL_BLOCK_PRIVATE=1): refuse links that resolve to private/loopback/link-local addresses.
const BLOCK_PRIVATE = process.env.DL_BLOCK_PRIVATE === '1';
function isPrivateIp(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function assertPublicUrl(raw) {
  if (!BLOCK_PRIVATE || /^magnet:/i.test(raw)) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address is not allowed.');
}

const app = express();
app.disable('x-powered-by');

// CORS: the Vercel-hosted UI is a different origin. Safe because auth is a bearer token, never a cookie,
// and a foreign Origin is never treated as local.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    if (req.headers['access-control-request-private-network']) res.set('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR)); // the UI itself is public; everything under /api and /files is not

app.get('/api/ping', (req, res) => res.json({ ok: true, local: isLocal(req), authed: authed(req) }));

app.post('/api/login', async (req, res) => {
  const now = Date.now(), ip = clientIp(req);
  const mine = recent(failedByIp.get(ip) || [], now); failedAll = recent(failedAll, now);
  if (mine.length >= 10 || failedAll.length >= 100) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 10 minutes.' });
  const given = String(req.body?.pin || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const a = Buffer.from(sha(given)), b = Buffer.from(sha(config.pin));
  if (!crypto.timingSafeEqual(a, b)) {
    failedByIp.set(ip, [...mine, now]); failedAll.push(now);
    if (failedByIp.size > 5000) failedByIp.clear(); // bound memory
    return res.status(401).json({ error: 'Wrong PIN.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  config.tokens = [...config.tokens, sha(token)].slice(-20);
  await saveConfig();
  res.json({ token });
});

app.use(['/api', '/files'], (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Login required' })));

// always serves from the *current* download folder
app.use('/files', (req, res, next) => express.static(DOWNLOADS, { dotfiles: 'deny', index: false })(req, res, next));

/** @type {Map<string, any>} */
const jobs = new Map();
const clients = new Set(); // SSE listeners
const torrentClient = new WebTorrent();

// torrent file list: live while the torrent is active, last snapshot afterwards
function torrentFiles(j) {
  const t = j.torrent;
  if (t && !t.destroyed && t.files?.length) {
    j.filesSnap = t.files.slice(0, 500).map((f) => ({
      path: f.path.split(path.sep).join('/'), name: f.name, size: f.length, progress: Math.min(1, Math.max(0, f.progress || 0)),
    }));
    j.filesTotal = t.files.length;
  }
  return j.filesSnap;
}
const publicJob = (j) => ({
  id: j.id, url: j.url, kind: j.kind, status: j.status, progress: j.progress,
  speed: j.speed, eta: j.eta, name: j.name, file: j.file, error: j.error,
  files: j.kind === 'torrent' ? torrentFiles(j) : undefined, filesTotal: j.filesTotal,
});
function emit(job) {
  const data = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of clients) res.write(data);
}
function update(job, patch) { Object.assign(job, patch); emit(job); }

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'download';
const fmtSpeed = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s');

// Torrent-cache links (torrage.info/torrent.php?h=<hash>, itorrents.org/torrent/<HASH>.torrent) and bare info-hashes
// are turned into magnet links, which the torrent engine finds via DHT + public trackers.
const PUBLIC_TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce', 'wss://tracker.webtorrent.dev'];
const CACHE_HOSTS = /(torrage|itorrents|torcache|btcache|thetorrent)/i;
function toMagnet(input) {
  let hash = null;
  if (/^[0-9a-f]{40}$/i.test(input) || /^[A-Z2-7]{32}$/i.test(input)) hash = input;
  else {
    try {
      const u = new URL(input);
      const q = u.searchParams.get('hash') || u.searchParams.get('infohash') || u.searchParams.get('btih') || (CACHE_HOSTS.test(u.hostname) ? u.searchParams.get('h') : null);
      if (q && /^[0-9a-f]{40}$/i.test(q)) hash = q;
      else if (CACHE_HOSTS.test(u.hostname)) hash = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/i.exec(u.pathname)?.[0] || null;
    } catch { /* not a URL */ }
  }
  return hash ? `magnet:?xt=urn:btih:${hash}` + PUBLIC_TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('') : null;
}

// Pages that don't look like files by name: peek at what the server really returns.
async function probeKind(url) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-1023' } });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const cd = res.headers.get('content-disposition') || '';
    let first = Buffer.alloc(0);
    if (res.body && ct.includes('octet-stream')) { const r = res.body.getReader(); const { value } = await r.read(); first = Buffer.from(value || []); await r.cancel(); }
    else await res.body?.cancel();
    if (/bittorrent/.test(ct) || /\.torrent/i.test(cd)) return 'torrent';
    if (first.length && /^d\d+:/.test(first.toString('latin1', 0, 16)) && /announce|4:info/.test(first.toString('latin1'))) return 'torrent'; // bencoded dictionary
    if (/^(application\/(octet-stream|zip|pdf|x-.*zip.*|x-7z.*|x-rar.*)|image\/|video\/|audio\/)/.test(ct)) return 'direct';
    return 'media'; // html pages etc. -> yt-dlp
  } catch { return 'media'; } finally { clearTimeout(timer); }
}

function detectKind(input) {
  if (/^magnet:\?/i.test(input)) return 'torrent';
  let u;
  try { u = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (/\.torrent$/i.test(u.pathname)) return 'torrent';
  if (/\.(zip|rar|7z|iso|exe|msi|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|csv|txt|apk|dmg|tar|gz|mp4|mkv|webm|mp3|m4a|wav|flac)$/i.test(u.pathname)) return 'direct';
  return 'media';
}

// ---------- video / audio via yt-dlp ----------
function runMedia(job, format) {
  if (!existsSync(YTDLP)) {
    return update(job, { status: 'error', error: 'yt-dlp missing. Run: npm run setup' });
  }
  const args = ['--newline', '--no-playlist', '--ffmpeg-location', FFMPEG,
    '-o', path.join(DOWNLOADS, '%(title).150B [%(id)s].%(ext)s'),
    '--progress-template', 'download:PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:FILE|%(filepath)s'];
  if (process.env.DL_JS_RUNTIME) args.push('--js-runtimes', process.env.DL_JS_RUNTIME); // YouTube needs a JS runtime (node in Docker)
  const cookies = process.env.DL_COOKIES || path.join(DATA_DIR, 'cookies.txt'); // optional: export from a logged-in browser if a site blocks the server
  if (existsSync(cookies)) args.push('--cookies', cookies);
  if (format === 'mp3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else if (format === 'm4a') args.push('-x', '--audio-format', 'm4a');
  else args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
  args.push('--', job.url); // '--' stops option injection from the URL

  const p = spawn(YTDLP, args, { windowsHide: true });
  job.proc = p;
  let errBuf = '';
  const onLine = (line) => {
    if (line.startsWith('PROG|')) {
      const [, pct, speed, eta] = line.split('|');
      update(job, { status: 'downloading', progress: parseFloat(pct) || 0, speed: speed.trim(), eta: eta.trim() });
    } else if (line.startsWith('FILE|')) {
      job.file = path.basename(line.slice(5).trim());
      job.name = job.file;
    }
  };
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
  p.stderr.on('data', (d) => { errBuf += d; });
  p.on('error', (e) => update(job, { status: 'error', error: e.message }));
  p.on('close', (code) => {
    if (job.status === 'cancelled') return;
    if (code === 0) update(job, { status: 'done', progress: 100, speed: '', eta: '' });
    else {
      let msg = errBuf.trim().split('\n').pop() || `yt-dlp exited ${code}`;
      if (/Unsupported URL/i.test(msg)) msg = 'No downloadable video or audio found on that page. For torrents use a magnet link, a .torrent file URL or the info-hash.';
      update(job, { status: 'error', error: msg });
    }
  });
}

// ---------- direct file ----------
async function runDirect(job) {
  const ac = new AbortController();
  job.abort = () => ac.abort();
  try {
    const res = await fetch(job.url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let name = path.basename(new URL(res.url).pathname) || 'download';
    const cd = res.headers.get('content-disposition');
    const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    if (m) name = decodeURIComponent(m[1]);
    name = safeName(name);
    const total = Number(res.headers.get('content-length')) || 0;
    const dest = path.join(DOWNLOADS, name);
    job.file = name; job.name = name;
    let got = 0, last = Date.now(), lastBytes = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => {
      got += c.length;
      const now = Date.now();
      if (now - last > 500) {
        update(job, { status: 'downloading', progress: total ? (got / total) * 100 : 0,
          speed: fmtSpeed(((got - lastBytes) * 1000) / (now - last)) });
        last = now; lastBytes = got;
      }
    });
    await pipeline(body, createWriteStream(dest), { signal: ac.signal });
    update(job, { status: 'done', progress: 100, speed: '' });
  } catch (e) {
    if (job.status !== 'cancelled') update(job, { status: 'error', error: e.message });
  }
}

// ---------- torrent / magnet ----------
async function runTorrent(job) {
  try {
    let source = job.url;
    if (/^https?:/i.test(source)) { // .torrent URL -> fetch bytes
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      source = Buffer.from(await res.arrayBuffer());
    }
    update(job, { status: 'fetching metadata' });
    const t = torrentClient.add(source, { path: DOWNLOADS });
    job.torrent = t;
    t.on('ready', () => { job.name = t.name; job.file = t.name; update(job, { status: 'downloading' }); }); // metadata fetched -> file list is now available
    t.on('download', () => {
      if (Date.now() - (job._last || 0) < 500) return;
      job._last = Date.now();
      update(job, { status: 'downloading', progress: t.progress * 100, speed: fmtSpeed(t.downloadSpeed),
        eta: t.timeRemaining ? Math.round(t.timeRemaining / 1000) + 's' : '' });
    });
    t.on('done', () => update(job, { status: 'done', progress: 100, speed: '', eta: '' }));
    t.on('error', (e) => update(job, { status: 'error', error: /duplicate/i.test(String(e.message || e)) ? 'This torrent is already in the list (finished or still downloading).' : String(e.message || e) }));
  } catch (e) {
    update(job, { status: 'error', error: /duplicate/i.test(e.message) ? 'This torrent is already in the list (finished or still downloading).' : e.message });
  }
}

// ---------- API ----------
app.post('/api/download', async (req, res) => {
  let url = String(req.body?.url || '').trim();
  const format = ['mp4', 'mp3', 'm4a'].includes(req.body?.format) ? req.body.format : 'mp4';
  url = toMagnet(url) || url;
  let kind = detectKind(url);
  if (!kind) return res.status(400).json({ error: 'Enter an http(s) link, a magnet link, a .torrent URL or a torrent info-hash.' });
  try { await assertPublicUrl(url); } catch (e) { return res.status(400).json({ error: e.code === 'ENOTFOUND' ? 'Cannot resolve that address.' : e.message }); }
  if (kind === 'media') kind = await probeKind(url);
  const job = { id: randomUUID(), url, kind, status: 'queued', progress: 0, speed: '', eta: '', name: url, file: '', error: '' };
  jobs.set(job.id, job);
  emit(job);
  if (kind === 'media') runMedia(job, format);
  else if (kind === 'direct') runDirect(job);
  else runTorrent(job);
  res.json(publicJob(job));
});

app.post('/api/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.sendStatus(404);
  if (['done', 'error', 'cancelled'].includes(job.status)) return res.json(publicJob(job));
  job.proc?.kill();
  job.abort?.();
  job.torrent?.destroy();
  update(job, { status: 'cancelled', speed: '', eta: '' });
  res.json(publicJob(job));
});

// ---------- settings API (loopback only: a remote device must not choose folders on the PC) ----------
app.get('/api/settings', (req, res) => res.json(isLocal(req) ? { downloadDir: DOWNLOADS, canChange: true } : { downloadDir: null, canChange: false }));

// remote-access info for the PC's own screen: PIN + addresses phones can use
app.get('/api/remote-info', (req, res) => {
  if (!isLocal(req)) return res.sendStatus(403);
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${boundPort}`);
  res.json({ pin: config.pin, port: boundPort, lanUrls: HOST === '0.0.0.0' ? lan : [], lanEnabled: HOST === '0.0.0.0' });
});
app.post('/api/pin/regenerate', async (req, res) => { // also signs out every connected device
  if (!isLocal(req)) return res.sendStatus(403);
  config.pin = newPin(); config.tokens = []; await saveConfig();
  res.json({ pin: config.pin });
});

app.post('/api/settings', async (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Settings can only be changed on the PC itself.' });
  const dir = String(req.body?.downloadDir || '').trim();
  if (!dir || !path.isAbsolute(dir)) return res.status(400).json({ error: 'Enter a full folder path, e.g. D:\\Downloads' });
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, fsc.W_OK);
  } catch (e) { return res.status(400).json({ error: `Cannot use that folder: ${e.code || e.message}` }); }
  DOWNLOADS = path.resolve(dir);
  config.downloadDir = DOWNLOADS;
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ downloadDir: DOWNLOADS });
});

// folder browser for the "Browse" button (loopback only)
app.get('/api/browse', async (req, res) => {
  if (!isLocal(req)) return res.sendStatus(403);
  const p = String(req.query.path || '');
  try {
    if (!p) { // top level: drives on Windows, home on others
      if (process.platform !== 'win32') return res.json({ path: os.homedir(), parent: null, dirs: await listDirs(os.homedir()) });
      const drives = [];
      for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { await access(d); drives.push({ name: d, path: d }); } catch { /* no drive */ } }
      return res.json({ path: '', parent: null, dirs: drives });
    }
    const abs = path.resolve(p);
    const parent = path.dirname(abs) === abs ? '' : path.dirname(abs);
    res.json({ path: abs, parent, dirs: await listDirs(abs) });
  } catch (e) { res.status(400).json({ error: e.code || e.message }); }
});
async function listDirs(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  return items.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/api/jobs',(_req, res) => res.json([...jobs.values()].map(publicJob)));

app.get('/api/files', async (_req, res) => {
  const out = [];
  async function walk(dir, rel = '') {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (!/\.(part|ytdl)$/i.test(e.name)) out.push({ name: r, size: (await stat(path.join(dir, e.name))).size });
    }
  }
  await walk(DOWNLOADS);
  res.json(out);
});

app.delete('/api/files', async (req, res) => {
  const target = path.resolve(DOWNLOADS, String(req.query.name || ''));
  if (!target.startsWith(DOWNLOADS + path.sep)) return res.sendStatus(400); // no path traversal
  try { await unlink(target); res.sendStatus(204); } catch { res.sendStatus(404); }
});

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// clean JSON errors instead of HTML stack traces
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON' : 'Server error' }));

let boundPort = PORT;
await new Promise((resolve, reject) => {
  const srv = app.listen(PORT, HOST, () => { boundPort = srv.address().port; resolve(); });
  srv.once('error', reject);
});
console.log(`Downloader running at http://127.0.0.1:${boundPort}${HOST === '0.0.0.0' ? ' (also on your LAN)' : ''}`);
console.log(PIN_FROM_ENV ? 'Remote PIN: set via DL_PIN' : `Remote PIN: ${config.pin}`); // never log a PIN that came from the environment

// keep SSE connections alive through proxies (they drop idle connections after ~60s)
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// optional auto-cleanup so a server disk doesn't fill up: DL_RETENTION_DAYS=7 deletes files older than 7 days
const RETENTION_MS = Number(process.env.DL_RETENTION_DAYS) * 86400000;
if (RETENTION_MS > 0) {
  const sweep = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await sweep(p);
      else if (Date.now() - (await stat(p)).mtimeMs > RETENTION_MS) await unlink(p).catch(() => {});
    }
  };
  setInterval(() => sweep(DOWNLOADS), 3600000).unref();
}
export { boundPort as port };
