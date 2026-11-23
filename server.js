import express from 'express';
import WebTorrent from 'webtorrent';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS = path.join(root, 'downloads');
const YTDLP = path.join(root, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // local only, never exposed to the network

await mkdir(DOWNLOADS, { recursive: true });

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(root, 'public')));
app.use('/files', express.static(DOWNLOADS, { dotfiles: 'deny', index: false }));

/** @type {Map<string, any>} */
const jobs = new Map();
const clients = new Set(); // SSE listeners
const torrentClient = new WebTorrent();

const publicJob = (j) => ({
  id: j.id, url: j.url, kind: j.kind, status: j.status, progress: j.progress,
  speed: j.speed, eta: j.eta, name: j.name, file: j.file, error: j.error,
});
function emit(job) {
  const data = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of clients) res.write(data);
}
function update(job, patch) { Object.assign(job, patch); emit(job); }

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'download';
const fmtSpeed = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s');

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
  const args = ['--newline', '--no-playlist', '--ffmpeg-location', ffmpegPath,
    '-o', path.join(DOWNLOADS, '%(title).150B [%(id)s].%(ext)s'),
    '--progress-template', 'download:PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:FILE|%(filepath)s'];
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
    else update(job, { status: 'error', error: errBuf.trim().split('\n').pop() || `yt-dlp exited ${code}` });
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
    t.on('ready', () => { job.name = t.name; job.file = t.name; emit(job); });
    t.on('download', () => {
      if (Date.now() - (job._last || 0) < 500) return;
      job._last = Date.now();
      update(job, { status: 'downloading', progress: t.progress * 100, speed: fmtSpeed(t.downloadSpeed),
        eta: t.timeRemaining ? Math.round(t.timeRemaining / 1000) + 's' : '' });
    });
    t.on('done', () => update(job, { status: 'done', progress: 100, speed: '', eta: '' }));
    t.on('error', (e) => update(job, { status: 'error', error: String(e.message || e) }));
  } catch (e) {
    update(job, { status: 'error', error: e.message });
  }
}

// ---------- API ----------
app.post('/api/download', (req, res) => {
  const url = String(req.body?.url || '').trim();
  const format = ['mp4', 'mp3', 'm4a'].includes(req.body?.format) ? req.body.format : 'mp4';
  const kind = detectKind(url);
  if (!kind) return res.status(400).json({ error: 'Enter an http(s) link, a magnet link or a .torrent URL.' });
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

app.get('/api/jobs', (_req, res) => res.json([...jobs.values()].map(publicJob)));

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
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.listen(PORT, HOST, () => console.log(`Downloader running at http://${HOST}:${PORT}`));
