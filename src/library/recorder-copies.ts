import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where an import keeps the recorder's original file next to the recording. */
export const deviceOriginalPath = (filePath: string, recordingId: string) => join(dirname(filePath), 'originals', recordingId, 'device-original.plaud');

/**
 * Why a recording must stay on the recorder, or null when OpenPlod holds a complete copy of exactly that
 * file: an imported recording whose playable audio exists and whose stored device original has the
 * recorder's size. A recording only in Trash still counts; its files stay until it is purged.
 */
export function localCopyRefusal(database: Database, serial: string, session: { sessionId: number; size: number }): string | null {
  const row = database.query("SELECT id, file_path AS filePath FROM recordings WHERE source_provider = 'plaud' AND source_recording_id = ?")
    .get(`${serial}:${session.sessionId}`) as { id: string; filePath: string } | null;
  if (!row) return 'Not imported into OpenPlod yet.';
  if (!existsSync(row.filePath)) return 'The audio file is missing from the OpenPlod library.';
  const original = deviceOriginalPath(row.filePath, row.id);
  if (!existsSync(original)) return 'OpenPlod has no copy of the original recorder file.';
  if (statSync(original).size !== session.size) return 'The copy in OpenPlod does not match the file on the recorder.';
  return null;
}

/** Notes in the recording's provenance that the recorder no longer has the file. */
export async function markDeletedFromRecorder(database: Database, serial: string, sessionId: number) {
  const row = database.query("SELECT id, file_path AS filePath FROM recordings WHERE source_provider = 'plaud' AND source_recording_id = ?")
    .get(`${serial}:${sessionId}`) as { id: string; filePath: string } | null;
  if (!row) return;
  const path = join(dirname(deviceOriginalPath(row.filePath, row.id)), 'provenance.json');
  const provenance = await readFile(path, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(() => null);
  if (provenance) await writeFile(path, JSON.stringify({ ...provenance, sourceRetained: false, deletedFromRecorderAt: new Date().toISOString() }), { mode: 0o600 });
}
