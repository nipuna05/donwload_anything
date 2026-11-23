#!/bin/sh
# Mounted volumes usually arrive root-owned: fix that, then run as the unprivileged "node" user.
if [ -z "$DL_PIN" ]; then echo "DL_PIN is not set. Set a PIN of at least 8 characters." >&2; exit 1; fi
chown -R node:node /data 2>/dev/null || true
exec runuser -u node -- sh -c './bin/yt-dlp -U >/dev/null 2>&1 || true; exec node server.js'
