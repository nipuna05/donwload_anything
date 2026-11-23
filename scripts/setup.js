// Downloads the yt-dlp binary into ./bin (ffmpeg comes from the ffmpeg-static npm package).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin');
const isWin = process.platform === 'win32';
const name = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`;

await mkdir(bin, { recursive: true });
console.log('Downloading', url);
const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const out = path.join(bin, isWin ? 'yt-dlp.exe' : 'yt-dlp');
await writeFile(out, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
console.log('Saved', out);
