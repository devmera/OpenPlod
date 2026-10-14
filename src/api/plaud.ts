import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from 'hono/bun';
import { PlaudEnrollment, type ApprovedPhone } from '../sync/plaud-enrollment';
import { loadIdentity } from '../sync/plaud-direct';
import { plaudTransfers } from '../sync/plaud-transfers';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { db, sqlite } from '../db/client';
import { PlaudAutoImport } from '../sync/plaud-auto-import';
import { PlaudWatcher } from '../sync/plaud-watch';
import { recordings, userSettings } from '../db/schema';
import { eq } from 'drizzle-orm';
import { configuredSyncPath, fingerprintFile, importRecordingFile, incomingDirectory, safeFilename } from '../library/recording-library';
import { queueRecordingProcessing } from '../library/processing';
import { saveGeneratedTranscript } from '../library/transcript-history';
import { FolderWatcher } from '../sync/folder-watcher';
import { scanDesktopPlaud } from '../sync/desktop-plaud';
import {
  PlaudBindError, bindDirectPlaudIdentity, cancelDirectPlaud, deleteDirectPlaudRecordings, unlinkDirectPlaud, directPlaudConfigured, importDirectPlaudRecording, readDirectPlaudRecordings,
} from '../sync/plaud-direct';
import { localCopyRefusal, markDeletedFromRecorder } from '../library/recorder-copies';
import { readDeviceCredentials } from '../sync/plaud-device-auth';
import { isBluetoothIdentifier } from '../sync/plaud-bridge';
import { detectPlaudEnvironment, type PlaudEnvironment } from '../sync/plaud-environment';
import {
  PlaudCloudClient, PlaudCloudError, clearStoredCloudToken, parseWorkspaceToken, readStoredCloudToken,
  writeStoredCloudToken, type PlaudCloudRecording,
} from '../sync/plaud-cloud';
import {
  DEFAULT_PLAUD_DOMAIN, PLAUD_DOMAINS, PlaudIdentityProvisioner, clearPendingIdentity, clearStoredIdentity, deviceTypeForSerial,
  generateLocalKeyPair, identityFilePath, isPlaudDomain, knownSerialCredentials, parseDeviceIdentity, provisionWithDeveloperCredentials, readPendingIdentity, readStoredIdentity,
  replaceStoredIdentity, retireStoredIdentity, writePendingIdentity, writeStoredIdentity, type KeySource, type ProvisionedIdentity,
} from '../sync/plaud-provision';

const app = new Hono();
app.use('*', bodyLimit({ maxSize: 16384 }));
export const automaticPlaud = new PlaudAutoImport(sqlite);
export const plaudWatcher = new PlaudWatcher(automaticPlaud);
const syncStatus = () => ({ ...automaticPlaud.status(), watch: plaudWatcher.status() });
app.get('/auto-import', c => c.json({ success: true, data: syncStatus() }));
// "Sync now": immediately when the recorder is in range, otherwise at its next beacon.
app.post('/auto-import/sync', c => { plaudWatcher.requestSync(); return c.json({ success: true, data: syncStatus() }); });
app.patch('/auto-import', async c => {
  try { const input = await c.req.json(); if (typeof input.enabled !== 'boolean') throw new Error('Import preference must be true or false.');
    return c.json({ success: true, data: automaticPlaud.set(input.enabled) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
});
// Phones approved for recorder access, listed on the Phone page. Approval hands the phone a copy of
// the recorder key; removing a phone here only forgets it, the phone keeps the key until unlinked.
const approvedPhonesKey = 'plaud.approvedPhones';
const approvedPhones = (): ApprovedPhone[] => {
  const row = sqlite.query('SELECT value FROM user_settings WHERE key = ?').get(approvedPhonesKey) as { value: string } | null;
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
};
const saveApprovedPhones = (phones: ApprovedPhone[]) => sqlite.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')")
  .run(approvedPhonesKey, JSON.stringify(phones));
const enrollment = new PlaudEnrollment(loadIdentity, undefined, phone => saveApprovedPhones([...approvedPhones(), phone]));
app.use('/authorizations/*', async (c, next) => { c.header('Cache-Control', 'no-store'); return next(); });
const localOwner = (c: Parameters<typeof getConnInfo>[0]) => {
  try { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(getConnInfo(c).remote.address ?? ''); } catch { return false; }
};
app.post('/authorizations', async c => {
  if (!process.env.OPENPLOD_PAIRING_TOKEN) return c.json({ success: false, error: 'Secure desktop pairing must be configured first.' }, 403);
  try { return c.json({ success: true, data: enrollment.create(await c.req.json()) }); }
  catch { return c.json({ success: false, error: 'Invalid authorization request or too many pending requests.' }, 400); }
});
app.get('/authorizations', c => localOwner(c) ? c.json({ success: true, data: enrollment.list() }) : c.json({ success: false, error: 'Open device authorization on the desktop.' }, 403));
app.get('/authorizations/:id', c => {
  try { return c.json({ success: true, data: enrollment.get(c.req.param('id')) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 404); }
});
app.post('/authorizations/:id/approve', async c => {
  if (!localOwner(c)) return c.json({ success: false, error: 'Approval must happen on this computer.' }, 403);
  try { const body = await c.req.json(); if (body.confirm !== true || typeof body.code !== 'string') throw new Error('Enter the verification code shown on your phone.');
    return c.json({ success: true, data: await enrollment.approve(c.req.param('id'), body.code) }); }
  catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
});
app.get('/approved-phones', c => localOwner(c) ? c.json({ success: true, data: approvedPhones() }) : c.json({ success: false, error: 'Open the phone list on the desktop.' }, 403));
app.delete('/approved-phones/:id', c => {
  if (!localOwner(c)) return c.json({ success: false, error: 'Use the desktop to change the phone list.' }, 403);
  saveApprovedPhones(approvedPhones().filter(phone => phone.id !== c.req.param('id')));
  return c.json({ success: true, data: { removed: true } });
});
app.post('/authorizations/:id/acknowledge', c => c.json({ success: true, data: enrollment.remove(c.req.param('id')) }));
app.delete('/authorizations/:id', c => localOwner(c) ? c.json({ success: true, data: enrollment.remove(c.req.param('id')) }) : c.json({ success: false, error: 'Use the desktop to decline authorization.' }, 403));
let importJob: { id: string; state: 'running' | 'complete' | 'failed'; result?: Awaited<ReturnType<typeof importDirectPlaudRecording>>; error?: string } | null = null;

app.get('/device-recordings', async c => {
  c.header('Cache-Control', 'no-store');
  // ?cached=1: the list from the last background sync round, without connecting to the recorder.
  if (c.req.query('cached')) {
    const listing = automaticPlaud.lastListing;
    if (!listing) return c.json({ success: true, data: null, checkedAt: null });
    const saved = await db.select({ id: recordings.id, sourceId: recordings.sourceRecordingId, retention: recordings.retentionState })
      .from(recordings).where(eq(recordings.sourceProvider, 'plaud'));
    return c.json({ success: true, cached: true, checkedAt: listing.checkedAt, data: listing.sessions.map(session => {
      const existing = saved.find(recording => recording.sourceId === `${listing.serial}:${session.sessionId}`);
      return { ...session, recordingId: existing?.id ?? null, retentionState: existing?.retention ?? null };
    }) });
  }
  try {
    const result = await readDirectPlaudRecordings();
    const saved = await db.select({ id: recordings.id, sourceId: recordings.sourceRecordingId, retention: recordings.retentionState })
      .from(recordings).where(eq(recordings.sourceProvider, 'plaud'));
    return c.json({ success: true, data: result.sessions.map(session => {
      const existing = saved.find(recording => recording.sourceId === `${result.serial}:${session.sessionId}`);
      return { ...session, recordingId: existing?.id ?? null, retentionState: existing?.retention ?? null };
    }), checkedAt: result.checkedAt });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Device recording list unavailable', recordingCount: null }, 503);
  }
});

app.post('/device-import', async c => {
  const body = await c.req.json<{ sessionId?: number; confirm?: boolean }>();
  if (!body.confirm || !Number.isSafeInteger(body.sessionId)) return c.json({ success: false, error: 'A session ID and import confirmation are required' }, 400);
  if (importJob?.state === 'running') return c.json({ success: false, error: 'A Plaud import is already running' }, 409);
  const job: NonNullable<typeof importJob> = { id: crypto.randomUUID(), state: 'running' };
  importJob = job;
  void importDirectPlaudRecording(body.sessionId!).then(result => { job.result = result; job.state = 'complete'; })
    .catch(error => { job.error = error instanceof Error ? error.message : 'Plaud import failed'; job.state = 'failed'; });
  return c.json({ success: true, data: { id: job.id } }, 202);
});

app.get('/device-import/:id', c => {
  c.header('Cache-Control', 'no-store');
  return importJob?.id === c.req.param('id') ? c.json({ success: true, data: importJob })
    : c.json({ success: false, error: 'Import job unavailable; refresh the library before retrying' }, 404);
});
/**
 * Deletes recordings from the recorder to free its storage. Only from this computer, only with explicit
 * confirmation, and each only when OpenPlod holds a verified copy of that exact file.
 */
app.post('/device-delete', async c => {
  if (!localOwner(c)) return c.json({ success: false, error: 'Delete recordings from the recorder on this computer.' }, 403);
  const body = await c.req.json<{ sessionIds?: unknown; confirm?: boolean }>().catch(() => ({} as { sessionIds?: unknown; confirm?: boolean }));
  const ids = Array.isArray(body.sessionIds) ? body.sessionIds : [];
  if (body.confirm !== true || !ids.length || ids.length > 500 || !ids.every(id => Number.isSafeInteger(id))) return c.json({ success: false, error: 'Recordings and delete confirmation are required' }, 400);
  if (importJob?.state === 'running') return c.json({ success: false, error: 'Wait for the Plaud import to finish' }, 409);
  try {
    const outcomes = await deleteDirectPlaudRecordings(ids as number[], async (serial, session) => localCopyRefusal(sqlite, serial, session));
    const serial = (await loadIdentity()).serial;
    for (const outcome of outcomes) if (outcome.deleted) await markDeletedFromRecorder(sqlite, serial, outcome.sessionId).catch(() => undefined);
    return c.json({ success: true, data: outcomes });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Delete from the recorder failed' }, 503);
  }
});
app.post('/device-cancel', c => { cancelDirectPlaud(); return c.json({ success: true }); });
// Recordings moving from the recorder right now, shown as rows in the library while they transfer.
app.get('/transfers', c => { c.header('Cache-Control', 'no-store'); return c.json({ success: true, data: plaudTransfers.list() }); });

// ---------------------------------------------------------------------------
// Cloud transfer
//
// Reaching the copies Plaud already stores for this account needs a sign-in
// token but no recorder identity, so it works on a fresh computer where the
// Bluetooth handshake cannot run yet.
// ---------------------------------------------------------------------------

interface CloudImportJob {
  id: string;
  state: 'running' | 'complete' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  totalBytes: number;
  receivedBytes: number;
  current: string | null;
  imported: { sourceId: string; recordingId: string; title: string; added: boolean }[];
  failures: { sourceId: string; title: string; error: string }[];
  transcripts: number;
  summaries: number;
  transcriptFailures: { sourceId: string; title: string; error: string }[];
  error?: string;
}

let cloudImportJob: CloudImportJob | null = null;
let cloudImportCancelled = false;

/** True when the stored token's own expiry has already passed. */
function workspaceExpired(token: string): boolean {
  try {
    const expiresAt = parseWorkspaceToken(token).expiresAt;
    return expiresAt !== null && expiresAt * 1000 <= Date.now();
  } catch {
    return false;
  }
}

/** A readable vault title for a cloud recording, keeping the audio extension. */
function cloudTitle(recording: PlaudCloudRecording): string {
  const cleaned = (recording.filename || recording.id).trim().replace(/[/\\]/g, '-').slice(0, 180) || 'Plaud recording';
  return /\.ogg$/i.test(cleaned) ? cleaned : `${cleaned}.ogg`;
}

/** Which cloud recordings are already in the library. */
async function importedCloudRecordings(): Promise<Map<string, string>> {
  const rows = await db.select({ sourceId: recordings.sourceRecordingId, id: recordings.id })
    .from(recordings).where(eq(recordings.sourceProvider, 'plaud'));
  return new Map(rows.filter(row => row.sourceId).map(row => [row.sourceId as string, row.id]));
}

const cloudSummary = (recording: PlaudCloudRecording, mapped: Map<string, string>) => ({
  id: recording.id,
  filename: recording.filename,
  recordedAt: recording.recordedAt,
  durationMs: recording.durationMs,
  sizeBytes: recording.sizeBytes,
  serial: recording.serial,
  isTrash: recording.isTrash,
  hasTranscript: recording.hasTranscript,
  hasSummary: recording.hasSummary,
  imported: mapped.has(recording.id),
  recordingId: mapped.get(recording.id) ?? null,
});

app.get('/cloud', async c => {
  c.header('Cache-Control', 'no-store');
  const token = await readStoredCloudToken();
  if (!token) return c.json({ success: true, data: { linked: false, account: null, domain: null, recordings: [], totals: { count: 0, bytes: 0, trashCount: 0, importedCount: 0 } } });
  try {
    const workspace = parseWorkspaceToken(token);
    const client = new PlaudCloudClient({ token });
    const found = await client.listRecordings({ includeTrash: true });
    const mapped = await importedCloudRecordings();
    return c.json({ success: true, data: {
      linked: true,
      account: { userId: workspace.userId, workspaceId: workspace.workspaceId, region: workspace.region, expiresAt: workspace.expiresAt },
      domain: client.resolvedDomain,
      recordings: found.map(recording => cloudSummary(recording, mapped)),
      totals: {
        count: found.length,
        bytes: found.reduce((sum, recording) => sum + recording.sizeBytes, 0),
        trashCount: found.filter(recording => recording.isTrash).length,
        importedCount: found.filter(recording => mapped.has(recording.id)).length,
      },
    }});
  } catch (error) {
    const expired = workspaceExpired(token);
    const message = expired ? 'This Plaud sign-in has expired. Sign in to web.plaud.ai again and paste a fresh token.'
      : error instanceof PlaudCloudError ? error.message : 'Plaud could not be reached. Check the connection and try again.';
    return c.json({ success: false, error: message }, 502);
  }
});

app.post('/cloud/token', async c => {
  let body: { token?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  if (typeof body.token !== 'string' || body.token.trim().length === 0) {
    return c.json({ success: false, error: 'Paste the Plaud sign-in token from web.plaud.ai.' }, 400);
  }
  try {
    const workspace = parseWorkspaceToken(body.token);
    const client = new PlaudCloudClient({ token: workspace.token });
    // Listing once proves the token really works before it is stored.
    const found = await client.listRecordings({ includeTrash: true });
    await writeStoredCloudToken(workspace.token);
    return c.json({ success: true, data: {
      linked: true, userId: workspace.userId, region: workspace.region, domain: client.resolvedDomain,
      expiresAt: workspace.expiresAt, count: found.length, bytes: found.reduce((sum, recording) => sum + recording.sizeBytes, 0),
    }});
  } catch (error) {
    const message = error instanceof PlaudCloudError ? error.message : 'Plaud could not be reached. Check the connection and try again.';
    return c.json({ success: false, error: message }, 400);
  }
});

app.delete('/cloud/token', async c => {
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { removed: await clearStoredCloudToken() } });
});

app.post('/cloud/import', async c => {
  let body: { ids?: unknown; includeTrash?: unknown; transcripts?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const token = await readStoredCloudToken();
  if (!token) return c.json({ success: false, error: 'Link your Plaud account before importing recordings.' }, 400);
  if (cloudImportJob?.state === 'running') return c.json({ success: false, error: 'A Plaud cloud import is already running.' }, 409);
  const requested = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : null;
  if (requested && requested.length === 0) return c.json({ success: false, error: 'Select at least one recording to import.' }, 400);
  const job: CloudImportJob = {
    id: crypto.randomUUID(), state: 'running', total: 0, completed: 0, totalBytes: 0, receivedBytes: 0,
    current: null, imported: [], failures: [], transcripts: 0, summaries: 0, transcriptFailures: [],
  };
  cloudImportJob = job;
  cloudImportCancelled = false;
  void runCloudImport({
    token, job, requested,
    includeTrash: body.includeTrash === true,
    // Plaud's own transcript and summary come along by default; a caller can opt out.
    includeTranscripts: body.transcripts !== false,
  }).catch(error => {
    job.error = error instanceof Error ? error.message : 'Plaud cloud import failed';
    job.state = 'failed';
  });
  return c.json({ success: true, data: { id: job.id } }, 202);
});

app.get('/cloud/import/:id', c => {
  c.header('Cache-Control', 'no-store');
  return cloudImportJob?.id === c.req.param('id')
    ? c.json({ success: true, data: cloudImportJob })
    : c.json({ success: false, error: 'Import job unavailable; refresh the library before retrying.' }, 404);
});

app.post('/cloud/cancel', c => { cloudImportCancelled = true; return c.json({ success: true }); });

/**
 * Copies the transcript and summary Plaud already wrote onto the imported
 * recording, so the library reads the same as the phone and web apps. This is
 * best-effort: the audio is already safe in the vault, so a missing transcript
 * is reported without failing the recording.
 */
async function storeCloudTranscript(params: {
  client: PlaudCloudClient;
  recording: PlaudCloudRecording;
  recordingId: string;
  job: CloudImportJob;
}): Promise<boolean> {
  const { client, recording, recordingId, job } = params;
  try {
    // Plaud's own `is_trans` flag is unreliable: recordings it marks as
    // untranscribed can still return a full transcript, so ask every time.
    const transcript = await client.transcript(recording.id);
    if (!transcript || transcript.segments.length === 0) return false;
    const summary = transcript.summaryMarkdown
      ? { overview: transcript.summaryMarkdown, ...(transcript.summaryMeta ?? {}) }
      : null;
    // Identical text keeps the same version id, so re-importing is idempotent
    // while an edited transcript on Plaud still lands as a new version.
    const digest = Bun.hash(`${transcript.fullText}\u0000${transcript.summaryMarkdown ?? ''}`).toString(16);
    const stored = saveGeneratedTranscript({
      recordingId,
      fullText: transcript.fullText,
      segments: transcript.segments,
      wordCount: transcript.fullText ? transcript.fullText.split(/\s+/).filter(Boolean).length : 0,
      speakerCount: transcript.speakerCount || null,
      confidence: null,
      summary,
      provenance: {
        provider: 'plaud',
        sourceRecordingId: recording.id,
        deviceSerial: recording.serial,
        taskId: transcript.taskId,
        fetchedAt: new Date().toISOString(),
      },
      generationId: `plaud:${recording.id}:${digest}`,
    });
    if (stored) {
      job.transcripts += 1;
      if (summary) job.summaries += 1;
    }
    return true;
  } catch (error) {
    job.transcriptFailures.push({
      sourceId: recording.id,
      title: recording.filename,
      error: error instanceof Error ? error.message : 'Transcript unavailable',
    });
    return false;
  }
}

async function runCloudImport(params: {
  token: string;
  job: CloudImportJob;
  requested: string[] | null;
  includeTrash: boolean;
  includeTranscripts: boolean;
}): Promise<void> {
  const { job } = params;
  const client = new PlaudCloudClient({ token: params.token });
  const onAccount = await client.listRecordings({ includeTrash: params.includeTrash });
  const selected = params.requested
    ? onAccount.filter(recording => params.requested!.includes(recording.id))
    : onAccount;
  job.total = selected.length;
  job.totalBytes = selected.reduce((sum, recording) => sum + recording.sizeBytes, 0);
  const staging = incomingDirectory();
  mkdirSync(staging, { recursive: true });

  for (const recording of selected) {
    if (cloudImportCancelled) { job.state = 'cancelled'; return; }
    job.current = recording.filename;
    const title = cloudTitle(recording);
    const stagePath = resolve(staging, `${crypto.randomUUID()}-${safeFilename(title)}`);
    let streamed = 0, sized = false;
    try {
      await client.download(recording.id, stagePath, (received, served) => {
        // The listing's size estimates the job total; the real size replaces it once the download starts.
        if (!sized && served > 0) { job.totalBytes += served - recording.sizeBytes; sized = true; }
        job.receivedBytes += received - streamed;
        streamed = received;
      });
      const result = await importRecordingFile({
        sourcePath: stagePath,
        originalFilename: title,
        metadata: { durationMs: recording.durationMs },
        provenance: {
          sourceProvider: 'plaud',
          sourceTransport: 'cloud',
          sourceRecordingId: recording.id,
          recordedAt: recording.recordedAt,
        },
      });
      const transcribed = params.includeTranscripts && !recording.isTrash
        ? await storeCloudTranscript({ client, recording, recordingId: result.recording.id, job })
        : false;
      job.imported.push({
        sourceId: recording.id, recordingId: result.recording.id,
        title: result.recording.originalFilename, added: result.added,
      });
      if (transcribed) {
        // Plaud already wrote the transcript and summary, so there is nothing
        // left to process locally.
        await db.update(recordings).set({ status: 'complete' }).where(eq(recordings.id, result.recording.id)).run();
      } else if (result.added) {
        await queueRecordingProcessing({ recordingId: result.recording.id, filePath: result.recording.filePath });
      }
    } catch (error) {
      job.failures.push({
        sourceId: recording.id, title: recording.filename,
        error: error instanceof Error ? error.message : 'Import failed',
      });
    } finally {
      await Bun.file(stagePath).delete().catch(() => undefined);
      job.completed += 1;
      job.current = null;
    }
  }
  job.state = cloudImportCancelled ? 'cancelled' : 'complete';
}

const authorizationError = (error: unknown) => error instanceof Error ? error.message : 'Plaud authorization failed';

// The recorder identity is a secret (it holds a private key), so it is never cached.
app.use('/identity', async (c, next) => { c.header('Cache-Control', 'no-store'); return next(); });
app.use('/identity/*', async (c, next) => { c.header('Cache-Control', 'no-store'); return next(); });

app.get('/identity', async c => {
  const identity = await readStoredIdentity();
  const credentials = await readDeviceCredentials();
  return c.json({ success: true, data: {
    authorized: Boolean(identity) && directPlaudConfigured(),
    serial: identity?.serial ?? null,
    identifier: identity?.identifier ?? null,
    deviceType: identity && /^[0-9A-F]{16}$/.test(identity.serial) ? deviceTypeForSerial(identity.serial) : null,
    keySource: identity ? identity.keySource ?? 'plaud' : null,
    // A local key the recorder may already hold: authorizing again finishes the bind with it.
    bindPending: Boolean(await readPendingIdentity()),
    developerCredentialsAvailable: Boolean(credentials.clientId && credentials.clientSecret),
    domains: PLAUD_DOMAINS,
    identityPath: identityFilePath(),
  }});
});

// Mint a device identity for this recorder. Either paste a Plaud sign-in token,
// or leave it out to use Plaud developer credentials when they are configured.
app.post('/identity', async c => {
  let body: { token?: string; domain?: string; serial?: string; identifier?: string; keySource?: KeySource };
  try { body = await c.req.json(); }
  catch { return c.json({ success: false, error: 'Invalid authorization request.' }, 400); }
  try {
    const givenSerial = typeof body.serial === 'string' && /^[0-9A-F]{16}$/.test(body.serial) ? body.serial : null;
    const givenIdentifier = typeof body.identifier === 'string' && isBluetoothIdentifier(body.identifier) ? body.identifier : null;
    // The serial and Bluetooth address come from the recorder's advertisement, so
    // probe for them instead of making the user type hardware identifiers.
    const probe = givenSerial && givenIdentifier ? null : await scanDesktopPlaud();
    const serial = givenSerial ?? probe?.serial ?? null;
    const identifier = givenIdentifier ?? probe?.identifier ?? null;
    if (!serial) throw new Error('Scan the recorder first so its serial number can be read.');
    if (!identifier) throw new Error('Scan the recorder first so its Bluetooth address can be read.');
    const domain = typeof body.domain === 'string' && isPlaudDomain(body.domain) ? body.domain : DEFAULT_PLAUD_DOMAIN;
    const keySource: KeySource = body.keySource === 'local' ? 'local' : 'plaud';
    // Retrying an interrupted local bind must offer the same key: the recorder may already hold it.
    const pending = keySource === 'local' ? await readPendingIdentity() : null;
    const localKeys = pending?.serial === serial ? { publicKey: pending.publicKey, privateKey: pending.privateKey } : undefined;
    // A local key needs only the serial signature, which never changes; reuse one this computer holds.
    const known = keySource === 'local' && !body.token?.trim() ? await knownSerialCredentials(serial) : null;
    const identity: ProvisionedIdentity = known
      ? { identifier, serial, ...known, ...(localKeys ?? generateLocalKeyPair()), keySource, deviceType: deviceTypeForSerial(serial) }
      : body.token?.trim()
        ? await new PlaudIdentityProvisioner().provision({ token: body.token, serial, identifier, domain, keySource, localKeys })
        : await provisionWithDeveloperCredentials({ serial, identifier, domain, keySource, localKeys });
    if (keySource === 'plaud') {
      await writeStoredIdentity(identity);
    } else {
      // The private key exists only here, so it is on disk before the recorder can store its half.
      await writePendingIdentity(identity);
      try { await bindDirectPlaudIdentity(identity); }
      catch (error) {
        if (!(error instanceof PlaudBindError && error.keyRequested)) await clearPendingIdentity();
        throw error;
      }
      await replaceStoredIdentity(identity);
      await clearPendingIdentity();
    }
    return c.json({ success: true, data: {
      authorized: true, serial: identity.serial, identifier: identity.identifier, deviceType: identity.deviceType, keySource,
    }});
  } catch (error) { return c.json({ success: false, error: authorizationError(error) }, 400); }
});

// Bring an identity from another tool (for example a recorder already bound to a
// key generated elsewhere). It replaces the current one only after validation,
// and a different current identity is kept beside it rather than overwritten.
app.post('/identity/import', async c => {
  let body: { identity?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ success: false, error: 'Invalid identity file.' }, 400); }
  try {
    const identity = parseDeviceIdentity(body.identity);
    const { previousKept } = await replaceStoredIdentity(identity);
    return c.json({ success: true, data: {
      authorized: directPlaudConfigured(), serial: identity.serial, identifier: identity.identifier,
      deviceType: deviceTypeForSerial(identity.serial), keySource: identity.keySource, previousKept,
    }});
  } catch (error) { return c.json({ success: false, error: authorizationError(error) }, 400); }
});

// Unlink the recorder from this computer's key (recordings stay on the recorder).
// The owner's action from the Plaud app, needed here because a recorder bound to
// a locally generated key cannot be unlinked by the Plaud app.
app.post('/identity/unlink', async c => {
  try {
    const { confirmed } = await unlinkDirectPlaud();
    await retireStoredIdentity();
    return c.json({ success: true, data: { unlinked: true, confirmed } });
  } catch (error) { return c.json({ success: false, error: authorizationError(error) }, 400); }
});

app.delete('/identity', async c => c.json({ success: true, data: { removed: await clearStoredIdentity() } }));

// ---------------------------------------------------------------------------
// Host autodetection
//
// Direct transfer needs a Bluetooth backend, the bridge helper, a powered
// adapter, ffmpeg/ffprobe and a recorder identity. Reporting them separately
// lets the UI name the one thing that is missing instead of "scan failed".
// ---------------------------------------------------------------------------

// Detection spawns short-lived helpers, so a burst of polls shares one result.
let environmentCache: { value: PlaudEnvironment; expires: number } | null = null;
let environmentPending: Promise<PlaudEnvironment> | null = null;

export async function plaudEnvironment(maxAgeMs = 15_000): Promise<PlaudEnvironment> {
  if (environmentCache && environmentCache.expires > Date.now()) return environmentCache.value;
  environmentPending ??= detectPlaudEnvironment()
    .then(value => { environmentCache = { value, expires: Date.now() + maxAgeMs }; return value; })
    .finally(() => { environmentPending = null; });
  return environmentPending;
}

app.get('/environment', async c => {
  c.header('Cache-Control', 'no-store');
  // A forced refresh is what the "Re-check" button in the UI sends.
  if (c.req.query('refresh') === '1') environmentCache = null;
  return c.json({ success: true, data: await plaudEnvironment() });
});

app.get('/status', async c => {
  const syncPath = await configuredSyncPath();
  const environment = await plaudEnvironment();
  // Scanning the air is pointless when the host itself cannot do Bluetooth.
  const bluetoothUsable = environment.checks
    .filter(check => check.id === 'platform' || check.id === 'bridge' || check.id === 'adapter')
    .every(check => check.ok);
  const device = bluetoothUsable
    ? await scanDesktopPlaud()
    : { detected: false, name: null, connectionVerified: false, identifier: null, serial: null,
        protocolVersion: null, rssi: null,
        detail: environment.blockers[0]?.remediation ?? environment.blockers[0]?.detail
          ?? 'Bluetooth is unavailable on this computer.' };
  const folderAvailable = Boolean(syncPath && existsSync(syncPath));
  const cloudLinked = Boolean(await readStoredCloudToken());
  c.header('Cache-Control', 'no-store');
  return c.json({
    success: true,
    data: {
      platform: environment.platform,
      bluetoothBackend: environment.backend,
      bluetoothReady: environment.ready,
      environmentBlockers: environment.blockers.map(check => ({
        id: check.id, label: check.label, detail: check.detail, remediation: check.remediation,
      })),
      deviceDetected: device.detected,
      deviceName: device.name,
      detail: device.detail,
      connectionVerified: device.connectionVerified,
      deviceIdentifier: device.identifier,
      deviceSerial: device.serial,
      protocolVersion: device.protocolVersion,
      directTransferAvailable: directPlaudConfigured(),
      cloudLinked,
      recordingListState: 'unavailable',
      deviceRecordingCount: null,
      folderAvailable,
      // Legacy field refers only to folder import, never direct-device transfer.
      transferAvailable: folderAvailable,
      syncPath,
    },
  });
});

app.get('/available-recordings', async c => {
  const syncPath = await configuredSyncPath();
  if (!syncPath) return c.json({ success: true, data: [] });
  const watcher = new FolderWatcher(syncPath);
  const files = await watcher.listRecordings();
  const known = await db.select({
    id: recordings.id,
    fingerprint: recordings.fingerprint,
    retentionState: recordings.retentionState,
  }).from(recordings);
  const byFingerprint = new Map<string, { id: string; retentionState: string | null }>();
  for (const row of known) if (row.fingerprint && !byFingerprint.has(row.fingerprint)) byFingerprint.set(row.fingerprint, row);
  const available = await mapWithConcurrency(files, 4, async file => {
    const fingerprint = await fingerprintFile(file.path);
    const durationMs = await audioDurationMs(file.path);
    const existing = byFingerprint.get(fingerprint);
    return {
      filename: file.filename,
      path: file.path,
      size: file.size,
      modifiedAt: file.modifiedAt.toISOString(),
      durationMs,
      fingerprint,
      imported: Boolean(existing),
      recordingId: existing?.id ?? null,
      retentionState: existing?.retentionState ?? null,
    };
  });
  return c.json({ success: true, data: available });
});

async function audioDurationMs(filePath: string): Promise<number | null> {
  try {
    const processHandle = Bun.spawn([
      'ffprobe',
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { stdout: 'pipe', stderr: 'ignore' });
    const output = await new Response(processHandle.stdout).text();
    if (await processHandle.exited !== 0) return null;
    const seconds = Number.parseFloat(output.trim());
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export default app;
