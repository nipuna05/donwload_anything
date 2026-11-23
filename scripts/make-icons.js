// Generates the app icons (PNG) with no dependencies: node scripts/make-icons.js
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function inTri(x, y, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([x, y], a, b), d2 = s([x, y], b, c), d3 = s([x, y], c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const arrow = (x, y) =>
  rect(x, y, 0.445, 0.22, 0.555, 0.50) ||
  inTri(x, y, [0.30, 0.46], [0.70, 0.46], [0.5, 0.67]) ||
  rect(x, y, 0.28, 0.72, 0.72, 0.78) || rect(x, y, 0.28, 0.62, 0.34, 0.78) || rect(x, y, 0.66, 0.62, 0.72, 0.78);
function inRounded(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function png(size, { rounded }) {
  const SS = 3, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
        if (rounded && !inRounded(x, y, 0.22)) continue;
        let c;
        if (arrow(x, y)) c = [255, 255, 255];
        else { const t = (x + y) / 2; c = [47 + (29 - 47) * t, 111 + (79 - 111) * t, 237 + (196 - 237) * t]; }
        rr += c[0]; gg += c[1]; bb += c[2]; aa += 255;
      }
      const n = SS * SS, i = py * (size * 4 + 1) + 1 + px * 4;
      raw[i] = aa ? rr / (aa / 255) : 0; raw[i + 1] = aa ? gg / (aa / 255) : 0; raw[i + 2] = aa ? bb / (aa / 255) : 0; raw[i + 3] = aa / n;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(path.join(root, 'build'), { recursive: true });
const out = {
  'public/icon-192.png': png(192, { rounded: true }),
  'public/icon-512.png': png(512, { rounded: true }),
  'public/icon-maskable-512.png': png(512, { rounded: false }),
  'public/apple-touch-icon.png': png(180, { rounded: false }),
  'build/icon.png': png(512, { rounded: true }),
};
for (const [f, buf] of Object.entries(out)) { writeFileSync(path.join(root, f), buf); console.log('wrote', f, buf.length, 'bytes'); }
