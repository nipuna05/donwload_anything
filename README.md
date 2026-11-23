# URL Downloader

Local web app: paste a link, get the file.

- **Video/audio pages** (YouTube and ~1000 other sites) -> MP4 / MP3 / M4A via yt-dlp + ffmpeg
- **Magnet links and .torrent URLs** -> WebTorrent
- **Direct file links** -> streamed download

## Run
```
npm install
npm run setup   # downloads yt-dlp into ./bin
npm start       # http://127.0.0.1:3000
```
Files land in `./downloads`. The server binds to localhost only.

Only download content you own or are licensed to download.
