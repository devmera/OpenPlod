import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsPlaybackCopy, playbackCopyPath, playbackFile, removePlaybackCopy } from './playback-copy';

const root = mkdtempSync(join(tmpdir(), 'openplod-playback-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const duration = async (path: string) => Number((await new Response(Bun.spawn(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout).text()).trim());

test('formats that drift get one cached AAC copy with the same timeline', async () => {
  const original = join(root, 'r1.ogg');
  expect(await Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', original]).exited).toBe(0);
  expect(needsPlaybackCopy(original)).toBe(true);
  expect(needsPlaybackCopy(join(root, 'r2.m4a'))).toBe(false);
  expect(await playbackFile('r2', join(root, 'r2.m4a'))).toBe(join(root, 'r2.m4a'));

  const copy = await playbackFile('r1', original);
  expect(copy).toBe(playbackCopyPath('r1', original));
  expect(Math.abs(await duration(copy) - await duration(original))).toBeLessThan(0.05);
  const made = statSync(copy).mtimeMs;
  expect(await playbackFile('r1', original)).toBe(copy);
  expect(statSync(copy).mtimeMs).toBe(made);
  await removePlaybackCopy('r1', original);
  expect(existsSync(copy)).toBe(false);
});
