import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, stat, unlink, writeFile, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PlaudConnection, type PlaudIdentity } from './plaud-connection';
import { PlaudTransport } from './plaud-transport';
import { decodePlaudAudio } from './plaud-audio';
import { deletePlaudSession, downloadPlaudSession, listPlaudSessions, recordingHandshake } from './plaud-transfer';
import { plaudTransfers, type PlaudTransferPhase } from './plaud-transfers';
import type { PlaudSessionEntry } from './plaud-protocol';
import { fingerprintFile, importRecordingFile } from '../library/recording-library';
import { openPlaudCheckpoint } from './plaud-checkpoint';
import { bluetoothSupported, isBluetoothIdentifier, isDesktopPlatform } from './plaud-bridge';
import { BINDING_TOKEN_PATTERN, PLAUD_SERIAL_PATTERN, identityFilePath } from './plaud-provision';

interface DeviceIdentity extends PlaudIdentity { identifier: string; serial: string; bindingToken: string }
const vaultRoot = () => dirname(resolve(process.env.OPENPLOD_LIBRARY_PATH || './data/recordings'));
const identityPath = identityFilePath;
let active: AbortController | null = null;

export const directPlaudConfigured = () => isDesktopPlatform() && bluetoothSupported() && existsSync(identityPath());
export function cancelDirectPlaud() { active?.abort(); }

export async function loadIdentity(): Promise<DeviceIdentity> {
  const file = identityPath(), info = await stat(file);
  if (!info.isFile() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error('Plaud identity file must be private to this user');
  let identity: DeviceIdentity;
  try { identity = JSON.parse(await readFile(file, 'utf8')) as DeviceIdentity; }
  catch { throw new Error('Saved Plaud identity could not be read'); }
  if (!identity || typeof identity !== 'object') throw new Error('Invalid saved Plaud device identity');
  if (!isBluetoothIdentifier(identity.identifier)
    || !PLAUD_SERIAL_PATTERN.test(identity.serial) || !BINDING_TOKEN_PATTERN.test(identity.bindingToken)
    || typeof identity.signature !== 'string' || typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') {
    throw new Error('Invalid saved Plaud device identity');
  }
  return identity;
}

async function withDevice<T>(operation: (connection: PlaudConnection, identity: DeviceIdentity, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (active) throw new Error('A Plaud Bluetooth operation is already running');
  if (!directPlaudConfigured()) throw new Error('Authorize this Plaud recorder on this computer before connecting');
  const controller = new AbortController(); active = controller;
  try {
    const identity = await loadIdentity();
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted();
      const transport = new PlaudTransport(identity.identifier);
      const connection = new PlaudConnection(transport);
      const abort = () => { void connection.close(); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        await transport.wait(event => event.event === 'ready', 45000);
        await connection.establishEncryption(identity);
        await recordingHandshake(connection, identity.bindingToken);
        return await operation(connection, identity, controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (attempt !== 0 || !(error instanceof Error) || !/timeout|timed out|disconnected|bridge exited/i.test(error.message)) throw error;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        await connection.close();
      }
    }
    throw new Error('Plaud connection failed after one fresh retry');
  } finally { active = null; }
}

/**
 * Lists the recorder's recordings. With `settleMs`, lists again after that pause
 * in the same connection and reports which recordings kept their size: a
 * recording still being written grows, so only `stable` ones are safe to import.
 */
export async function readDirectPlaudRecordings(options: { settleMs?: number } = {}): Promise<{
  serial: string; sessions: PlaudSessionEntry[]; checkedAt: string; stable?: number[];
}> {
  return withDevice(async (connection, identity) => {
    let sessions = await listPlaudSessions(connection);
    let stable: number[] | undefined;
    if (options.settleMs) {
      const first = new Map(sessions.map(session => [session.sessionId, session.size]));
      await Bun.sleep(options.settleMs);
      sessions = await listPlaudSessions(connection);
      stable = sessions.filter(session => first.get(session.sessionId) === session.size).map(session => session.sessionId);
    }
    return { serial: identity.serial, sessions, stable, checkedAt: new Date().toISOString() };
  });
}

export type DeleteOutcome = { sessionId: number; deleted: boolean; reason?: string };

/**
 * Deletes recordings from the recorder, each only after `verify` confirms OpenPlod holds a complete copy
 * of exactly that file; `verify` returns why not otherwise. Every deletion is confirmed by listing the
 * recorder again, so a recording reported deleted is really gone and one reported kept is still there.
 */
export async function deleteDirectPlaudRecordings(sessionIds: number[], verify: (serial: string, session: PlaudSessionEntry) => Promise<string | null>): Promise<DeleteOutcome[]> {
  if (!sessionIds.length || sessionIds.some(id => !Number.isSafeInteger(id) || id < 0 || id > 0xffffffff)) throw new Error('Invalid Plaud session ID');
  return withDevice(async (connection, identity, signal) => {
    const outcomes = new Map<number, DeleteOutcome>();
    const present = await listPlaudSessions(connection);
    for (const sessionId of sessionIds) {
      signal.throwIfAborted();
      const session = present.find(item => item.sessionId === sessionId);
      // Already absent, e.g. deleted before a dropped connection was retried.
      if (!session) { outcomes.set(sessionId, { sessionId, deleted: true }); continue; }
      const refusal = await verify(identity.serial, session);
      if (refusal) { outcomes.set(sessionId, { sessionId, deleted: false, reason: refusal }); continue; }
      try { await deletePlaudSession(connection, sessionId); }
      catch (error) { outcomes.set(sessionId, { sessionId, deleted: false, reason: error instanceof Error ? error.message : 'Delete failed' }); }
    }
    const remaining = new Set((await listPlaudSessions(connection)).map(session => session.sessionId));
    return sessionIds.map(sessionId => {
      const outcome = outcomes.get(sessionId);
      if (outcome && !outcome.deleted) return outcome;
      return remaining.has(sessionId) ? { sessionId, deleted: false, reason: 'The recorder still lists this recording.' } : { sessionId, deleted: true };
    });
  });
}

async function durableCopy(source: string, destination: string) {
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const file = await open(destination, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

async function runAudioTool(command: string[]) {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error('Local audio verification or conversion failed');
    return output;
  } finally { clearTimeout(timer); }
}

export async function importDirectPlaudRecording(sessionId: number) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) throw new Error('Invalid Plaud session ID');
  let size = 0;
  try {
    const result = await transferDirectPlaudRecording(sessionId, (patch, total) => { size = total; plaudTransfers.update(sessionId, total, patch); });
    plaudTransfers.finish(sessionId);
    return result;
  } catch (error) {
    if (size) plaudTransfers.fail(sessionId, error instanceof Error ? error.message : 'Transfer failed');
    else plaudTransfers.finish(sessionId);
    throw error;
  }
}

async function transferDirectPlaudRecording(sessionId: number, report: (patch: { phase: PlaudTransferPhase; received?: number }, size: number) => void) {
  return withDevice(async (connection, identity, signal) => {
    const sessions = await listPlaudSessions(connection);
    const selected = sessions.find(session => session.sessionId === sessionId);
    if (!selected) throw new Error('Recording is no longer available on the Plaud');
    const resumeDirectory = join(vaultRoot(), 'incoming', 'plaud-resume');
    await mkdir(resumeDirectory, { recursive: true, mode: 0o700 });
    const resumePath = join(resumeDirectory, `${identity.serial}-${sessionId}-${selected.size}.part`);
    const previous = await readFile(resumePath).catch(() => Buffer.alloc(0));
    const prefix = previous.subarray(0, Math.min(previous.length, selected.size - 1));
    const checkpoint = await openPlaudCheckpoint(resumePath, prefix.length);
    report({ phase: 'downloading', received: prefix.length }, selected.size);
    const downloaded = await downloadPlaudSession(connection, selected, { prefix, checkpoint: bytes => checkpoint.save(bytes),
      progress: received => report({ phase: 'downloading', received }, selected.size) })
      .finally(() => checkpoint.close());
    report({ phase: 'decoding', received: selected.size }, selected.size);
    const decoded = await decodePlaudAudio(downloaded.bytes, async ciphertext => {
      const reply = await connection.transport.request('rsa-decrypt', { key: identity.privateKey, data: ciphertext.toString('base64') });
      return Buffer.from(reply.data ?? '', 'base64');
    });
    const retained = await listPlaudSessions(connection);
    if (!retained.some(session => session.sessionId === selected.sessionId && session.size === selected.size)) throw new Error('Source retention could not be confirmed');
    await mkdir(join(vaultRoot(), 'incoming'), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(vaultRoot(), 'incoming', 'plaud-'));
    const encryptedPath = join(temporary, 'original.plaud'), oggPath = join(temporary, 'audio.ogg'), playbackPath = join(temporary, 'audio.m4a');
    try {
      await writeFile(encryptedPath, downloaded.bytes, { mode: 0o600 });
      await writeFile(oggPath, decoded.audio, { mode: 0o600 });
      await runAudioTool(['ffmpeg', '-v', 'error', '-xerror', '-n', '-i', oggPath, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', playbackPath]);
      const probe = JSON.parse(await runAudioTool(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', playbackPath]));
      const duration = Number(probe.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Decoded Plaud recording has no playable duration');
      signal.throwIfAborted();
      report({ phase: 'saving', received: selected.size }, selected.size);
      const result = await importRecordingFile({ sourcePath: playbackPath, originalFilename: `Plaud-${sessionId}.m4a`,
        provenance: { sourceProvider: 'plaud', sourceTransport: 'ble', sourceRecordingId: `${identity.serial}:${sessionId}` },
        metadata: { durationMs: Math.round(duration * 1000) } });
      const originalDirectory = join(dirname(result.recording.filePath), 'originals', result.recording.id);
      await mkdir(originalDirectory, { recursive: true, mode: 0o700 });
      // Import idempotency must not replace original evidence on a duplicate request.
      if (!existsSync(join(originalDirectory, 'device-original.plaud'))) {
        await durableCopy(encryptedPath, join(originalDirectory, 'device-original.plaud'));
        await durableCopy(oggPath, join(originalDirectory, 'decoded-original.ogg'));
        await writeFile(join(originalDirectory, 'provenance.json'), JSON.stringify({
          serial: identity.serial, session: selected, sourceTransport: 'ble', sourceRetained: true,
          originalSha256: await fingerprintFile(encryptedPath), integrity: decoded.integrity,
          tailCrc: downloaded.tailCrc, tailChecksumValidated: false, durationMs: Math.round(duration * 1000),
          downloadedAt: new Date().toISOString(),
        }), { mode: 0o600 });
      }
      await unlink(resumePath).catch(() => undefined);
      // Like every other import path, honour "Transcribe after import" (or forwarding) for new recordings.
      // Imported lazily: the job queue opens the vault database on load.
      if (result.added) await import('../library/processing')
        .then(({ queueRecordingProcessing }) => queueRecordingProcessing({ recordingId: result.recording.id, filePath: result.recording.filePath }))
        .catch(error => console.error('[Plaud] Imported recording could not be queued for processing:', error));
      return { ...result, durationMs: Math.round(duration * 1000), sourceRetained: true };
    } finally {
      for (const path of [encryptedPath, oggPath, playbackPath]) await unlink(path).catch(() => undefined);
      await rmdir(temporary).catch(() => undefined);
    }
  });
}
