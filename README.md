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
