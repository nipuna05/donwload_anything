# Always-on server version (Railway, Fly.io, Render, any VPS). Serves the web app AND the API.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev          # also fetches the ffmpeg binary (ffmpeg-static)
COPY server.js converter.js ./
COPY public ./public
COPY scripts ./scripts
RUN node scripts/setup.js && chmod +x bin/yt-dlp   # downloads the Linux yt-dlp into ./bin

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production \
    DL_HOST=0.0.0.0 \
    DL_DATA=/data \
    DL_DOWNLOADS=/data/downloads \
    DL_BLOCK_PRIVATE=1 \
    DL_RETENTION_DAYS=7 \
    DL_JS_RUNTIME=node
# Required at runtime: DL_PIN (min 8 chars). Mount a volume at /data to keep files and sign-ins across restarts.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
