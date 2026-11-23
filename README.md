# URL Downloader

Paste a link, get the file. Runs on your PC; your phone can use it as a remote.

- **Video/audio pages** (YouTube and ~1000 other sites) -> MP4 / MP3 / M4A (yt-dlp + ffmpeg)
- **Magnet links and .torrent URLs** -> WebTorrent, with a live file list
- **Direct file links** -> streamed download
- Choose the save folder in the app (Browse button).

Only download content you own or are licensed to download.

## Windows portable app
```
npm install
npm run setup    # downloads yt-dlp into ./bin
npm run dist     # -> dist/URL-Downloader-portable-<version>.exe
```
Double-click the .exe. Settings go in `URL-Downloader-data/` and downloads in `Downloads/`, both next to the .exe.

> Dev note: if Electron exits silently when launched from a terminal inside VS Code, run `Remove-Item Env:ELECTRON_RUN_AS_NODE` first.

## Run without Electron
```
npm start        # http://127.0.0.1:3000
```

## Phone / any device (Vercel web app + your PC)
Vercel only serves the web page (`public/`). The downloading always happens on your PC.

1. **Deploy the page:** in Vercel, *Add New > Project*, import this GitHub repo. No build command; `vercel.json` already sets the output directory to `public`.
2. **Expose your PC securely over HTTPS** (a hosted https page can't call a plain-http address):
   `cloudflared tunnel --url http://localhost:3000` (free, no account) prints an `https://….trycloudflare.com` address. Tailscale Funnel also works.
3. **On the phone:** open your Vercel URL, enter that https address and the PIN shown in the PC app (card "Use from your phone"), then tap *Add to Home Screen* / *Install app*.

Security model: everything under `/api` and `/files` needs the PIN-issued token unless the request comes from the PC itself (no proxy headers, localhost Host, same origin). 10 wrong PINs lock logins for 10 minutes. "New PIN" signs out all phones. Choosing the save folder is only possible on the PC.

Same Wi-Fi without a tunnel: start with `DL_HOST=0.0.0.0` (the page must then be opened over http from the PC's address, not from Vercel).

## Notes
- Vercel cannot run yt-dlp, ffmpeg or torrents (short-lived functions, no disk), which is why it only hosts the UI.
- The 160 MB .exe is too big for the repo; attach it to a GitHub Release.

## Always-on server (works with your laptop off)
The same app runs in Docker on any always-on host. It serves the **web app and the API** at its own address, so you can just open that address in any browser (and install it on a phone). The Vercel page can also point at it.

**Railway (simplest):**
1. railway.com > New Project > Deploy from GitHub repo > pick this repo (it detects the `Dockerfile`).
2. Add a **Volume** mounted at `/data` (keeps files and sign-ins across restarts).
3. Variables: `DL_PIN` = a long PIN of your own, at least 8 characters (this is your password, use 12 or more).
4. Settings > Networking > **Generate Domain**. Open that `https://….up.railway.app` address, enter the PIN.

Fly.io / Render / any VPS work the same way: build the `Dockerfile`, mount a volume at `/data`, set `DL_PIN`, expose port 3000 (or `$PORT`).

Server settings (already defaulted in the Dockerfile):
| Variable | Meaning |
|---|---|
| `DL_PIN` | **Required.** Login PIN, min 8 characters. |
| `DL_RETENTION_DAYS` | Auto-delete downloaded files older than N days (default 7) so the disk doesn't fill. |
| `DL_BLOCK_PRIVATE=1` | Refuse links that point at private/internal addresses (best-effort SSRF guard). |
| `DL_COOKIES` / `/data/cookies.txt` | Optional cookies file for sites that block the server. |

Things to know:
- **YouTube often blocks datacenter IPs.** Video downloads from a server can fail with a "sign in / confirm you're not a bot" error. A cookies file or a residential proxy helps but is not guaranteed. Torrents and direct links are unaffected.
- yt-dlp self-updates at every container start; redeploy/restart now and then if a site stops working.
- Files live on the server's volume and you download them to your phone from the app. Mind disk size and bandwidth costs.
- Keep the PIN long: the server is on the open internet. Wrong PINs lock out the guessing IP for 10 minutes.
- Download only what you're allowed to. You are responsible for what you fetch through your own server.
