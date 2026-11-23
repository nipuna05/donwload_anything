import { app, BrowserWindow, Menu, shell } from 'electron';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!app.requestSingleInstanceLock()) app.quit(); // one downloader at a time (port + config are shared)

// Portable build: keep settings and downloads next to the .exe so the folder can be moved/copied.
// If that folder is read-only, fall back to the normal per-user locations.
function writable(dir) { try { mkdirSync(dir, { recursive: true }); accessSync(dir, constants.W_OK); return true; } catch { return false; } }
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = portableDir && writable(path.join(portableDir, 'URL-Downloader-data'))
  ? path.join(portableDir, 'URL-Downloader-data') : app.getPath('userData');
const dlDir = portableDir && writable(path.join(portableDir, 'Downloads'))
  ? path.join(portableDir, 'Downloads') : path.join(app.getPath('downloads'), 'URL Downloader');
mkdirSync(dataDir, { recursive: true });

process.env.DL_DATA = dataDir;
process.env.DL_DOWNLOADS = dlDir;
process.env.DL_PUBLIC = path.join(root, 'public');
process.env.DL_BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(root, 'bin');

// prefer 3000 (stable address for the phone tunnel); otherwise any free port
function freePort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(preferred, '127.0.0.1', () => s.close(() => resolve(preferred)));
  });
}

let win;
async function createWindow() {
  process.env.PORT = String(await freePort(3000));
  const server = await import('../server.js'); // starts the downloader in-process
  win = new BrowserWindow({
    width: 1000, height: 800, minWidth: 420, minHeight: 500, title: 'URL Downloader',
    icon: path.join(root, 'build', 'icon.png'), backgroundColor: '#12151c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${server.port}`)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  await win.loadURL(`http://127.0.0.1:${server.port}`);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow().catch((e) => { console.error(e); app.quit(); });
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
