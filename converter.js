// Converts downloaded media with ffmpeg: any video -> MP4, or any video/audio -> MP3.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const VIDEO_EXT = /\.(mkv|avi|mov|wmv|flv|webm|ts|m2ts|mts|m4v|mpg|mpeg|3gp|ogv|vob|mp4)$/i;
export const AUDIO_EXT = /\.(flac|wav|m4a|aac|ogg|oga|opus|wma|aiff?|ape|mka|mp3)$/i;

/** What would this mode do with this file? Returns the output name, or null when nothing needs converting. */
export function targetFor(file, mode) {
  const base = file.replace(/\.[^.\\/]+$/, '');
  if (mode === 'mp4') return VIDEO_EXT.test(file) && !/\.mp4$/i.test(file) ? base + '.mp4' : null;
  if (mode === 'mp3') return (VIDEO_EXT.test(file) || AUDIO_EXT.test(file)) && !/\.mp3$/i.test(file) ? base + '.mp3' : null;
  return null;
}

function run(ffmpeg, args, { onErr, holder } = {}) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    if (holder) holder.proc = p;
    let err = '';
    p.stderr.on('data', (d) => { const s = d.toString(); err = (err + s).slice(-6000); onErr?.(s); });
    p.on('error', (e) => resolve({ code: -1, err: e.message }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

const secs = (t) => { const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

/** Reads duration and codecs from ffmpeg's own banner (no ffprobe needed). */
export async function probe(ffmpeg, file) {
  const { err } = await run(ffmpeg, ['-hide_banner', '-i', file]);
  return {
    duration: secs((/Duration:\s*([\d:.]+)/.exec(err) || [])[1] || ''),
    video: (/Stream #\d+:\d+[^\n]*?: Video: (\w+)/.exec(err) || [])[1] || null,
    audio: (/Stream #\d+:\d+[^\n]*?: Audio: (\w+)/.exec(err) || [])[1] || null,
    isMedia: /Stream #/.test(err),
  };
}

export function friendlyFfmpegError(err) {
  if (/Invalid data found|moov atom not found|could not find codec/i.test(err)) return 'The file is damaged or incomplete, so it could not be converted.';
  if (/No space left/i.test(err)) return 'There is not enough free disk space to convert this file.';
  if (/Permission denied/i.test(err)) return 'No permission to write the converted file.';
  if (/Unknown encoder|Encoder .* not found/i.test(err)) return 'The converter on this computer is missing a needed encoder.';
  if (/does not contain any stream|Output file does not contain/i.test(err)) return 'There is no audio or video in this file to convert.';
  const last = err.trim().split('\n').filter(Boolean).pop() || 'unknown error';
  return 'The converter failed: ' + last.slice(0, 160);
}

/**
 * Converts one file. `holder.proc` is set so the caller can cancel. `onProgress(0..1)` is called while running.
 * Video copying is used whenever the codecs are already MP4-compatible (fast, lossless); otherwise it re-encodes.
 */
export async function convertFile(ffmpeg, file, mode, { onProgress, holder } = {}) {
  let out = targetFor(file, mode);
  if (!out) return null;
  if (existsSync(out)) out = out.replace(/(\.\w+)$/, ' (converted)$1');
  const info = await probe(ffmpeg, file);
  if (!info.isMedia) throw new Error('This file is not a video or audio file that can be converted.');
  let args;
  if (mode === 'mp3') {
    if (!info.audio) throw new Error('There is no audio in this file to convert.');
    args = ['-y', '-i', file, '-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2', out];
  } else {
    if (!info.video) throw new Error('There is no video in this file to convert.');
    const v = info.video === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
    const a = ['aac', 'mp3'].includes(info.audio) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
    // first video + first audio only: drops extra tracks and subtitle formats MP4 cannot hold
    args = ['-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', ...v, ...a, '-movflags', '+faststart', out];
  }
  const { code, err } = await run(ffmpeg, args, {
    holder,
    onErr: (s) => { const m = /time=([\d:.]+)/.exec(s); if (m && info.duration) onProgress?.(Math.min(1, secs(m[1]) / info.duration)); },
  });
  if (code !== 0) throw new Error(holder?.killed ? 'Cancelled.' : friendlyFfmpegError(err));
  onProgress?.(1);
  return { out, name: path.basename(out) };
}
