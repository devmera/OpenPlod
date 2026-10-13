/**
 * Playback copies for formats WebKit times badly.
 *
 * Ogg/Opus, WebM and (VBR) MP3 carry no exact seek index, and the macOS web view drifts from the
 * file's real timeline as playback goes on, so transcript highlighting falls further behind. An
 * AAC copy in MP4 has an exact timeline. The original stays the library file (and export); the
 * copy is derived, cached beside it and recreated when the original changes.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

const NEEDS_COPY = new Set(['.ogg', '.opus', '.oga', '.webm', '.mp3']);
const pending = new Map<string, Promise<string>>();

export const needsPlaybackCopy = (filePath: string) => NEEDS_COPY.has(extname(filePath).toLowerCase());
export const playbackCopyPath = (recordingId: string, filePath: string) => join(dirname(filePath), 'playback', `${recordingId}.m4a`);

/** The file to play: the original, or an up-to-date AAC copy for formats that drift. */
export async function playbackFile(recordingId: string, filePath: string): Promise<string> {
  if (!needsPlaybackCopy(filePath)) return filePath;
  const copy = playbackCopyPath(recordingId, filePath);
  if (existsSync(copy) && statSync(copy).mtimeMs >= statSync(filePath).mtimeMs) return copy;
  const running = pending.get(recordingId);
  if (running) return running;
  const job = (async () => {
    await mkdir(dirname(copy), { recursive: true });
    const temporary = `${copy}.${process.pid}.tmp.m4a`;
    const process_ = Bun.spawn(['ffmpeg', '-v', 'error', '-y', '-i', filePath, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', temporary], { stderr: 'pipe' });
    if (await process_.exited !== 0) {
      await rm(temporary, { force: true });
      throw new Error(`Could not prepare audio for playback: ${(await new Response(process_.stderr).text()).trim().split('\n').at(-1) ?? 'ffmpeg failed'}`);
    }
    await rename(temporary, copy);
    return copy;
  })().finally(() => pending.delete(recordingId));
  pending.set(recordingId, job);
  return job;
}

/** Remove a recording's playback copy (purge, or the original was replaced). */
export async function removePlaybackCopy(recordingId: string, filePath: string) {
  await rm(playbackCopyPath(recordingId, filePath), { force: true });
}
