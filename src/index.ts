/**
 * Plaud App — standalone recording management server.
 * Hono + Drizzle + SQLite.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { initializeDatabase } from './db/setup';
import recordingsApi from './api/recordings';
import { FolderWatcher } from './sync/folder-watcher';
import { jobQueue } from './jobs/queue';
import { TranscriptionRouter } from './transcription/router';
import { db, sqlite } from './db/client';
import { OrganizerStore } from './organizer/store';
import { createOrganizerApi } from './api/organizer';
import { apiAccess } from './api/access';
import { RecordingAi } from './organizer/recording-ai';
import { createRecordingAiApi } from './api/recording-ai';
import { automaticPlaud, plaudWatcher } from './api/plaud';
import { recordings, userSettings } from './db/schema';
import { eq } from 'drizzle-orm';
import { searchTranscripts } from './search/transcripts';
import plaudApi from './api/plaud';
import mobileApi from './api/mobile';
import transcriptsApi from './api/transcripts';
import { configuredSyncPath, purgeExpiredTrash } from './library/recording-library';
import { saveGeneratedTranscript } from './library/transcript-history';
import { SpeakerIdentity } from './library/speaker-identity';
import { forwardRecordingWithRetry } from './library/forwarding';
import { createAiSettingsApi } from './api/ai-settings';
import { createSpeakersApi } from './api/speakers';
import { createObsidianApi } from './api/obsidian';
import { ObsidianExporter } from './library/obsidian-export';
import { createJobsApi } from './api/jobs';
import { createMeetingsApi } from './api/meetings';
import { MeetingRecorder, finalizeMeeting, meetingStagingDirectory, spawnMeetingBridge } from './meetings/meeting-recorder';
import { aiConfigSchema, readAiConfig, readSettings, assertPrivacy } from './ai/config';
import packageInfo from '../package.json';

// ============================================
// Create tables on startup
// ============================================

initializeDatabase();

console.log('[DB] Tables ready');

// ============================================
// Transcription router
// ============================================

const transcriptionRouter = new TranscriptionRouter();
const engineStatus = transcriptionRouter.status();
console.log('[Transcription] Engines:', Object.entries(engineStatus).map(([k, v]) => `${k}:${v ? '✓' : '✗'}`).join(' '));

// ============================================
// Register job handlers
// ============================================

// A summary asked for from the app runs as a queued job, so it continues after leaving the page and the
// recording shows "summarizing" meanwhile. A failure is kept on the recording for the app to show.
jobQueue.register('summarize-recording', async (data: any) => {
  const { recordingId } = data as { recordingId: string };
  await db.update(recordings).set({ status: 'summarizing', errorMessage: null }).where(eq(recordings.id, recordingId));
  try {
    const { recordingAnalyzer } = await import('./analysis/analyzer');
    await recordingAnalyzer.analyze(recordingId, true);
    await db.update(recordings).set({ status: 'complete', errorMessage: null }).where(eq(recordings.id, recordingId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Summary failed.';
    await db.update(recordings).set({ status: 'complete', errorMessage: `Summary failed: ${message}` }).where(eq(recordings.id, recordingId));
    throw error;
  }
});

jobQueue.register('process-recording', async (data: any, job) => {
  const { recordingId, filePath } = data;
  try {
  const recording = db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!recording || recording.retentionState !== 'active' || recording.fingerprint !== data.fingerprint) throw new Error('Recording is unavailable or its audio changed.');
  if (sqlite.query('SELECT id FROM transcript_versions WHERE id=? AND recording_id=?').get(job.id, recordingId)) {
    await db.update(recordings).set({ status: 'complete', errorMessage: null }).where(eq(recordings.id, recordingId));
    return;
  }
  const config = aiConfigSchema.parse(data.config);
  const currentConfig = readAiConfig(sqlite);
  assertPrivacy(currentConfig, config.transcriptionEngine);
  console.log(`[Job] Processing recording ${recordingId}`);

  await db.update(recordings).set({ status: 'transcribing' }).where(eq(recordings.id, recordingId));

  const savedSettings = await db.select().from(userSettings);
  const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
  const primary = config.transcriptionEngine;
  const router = new TranscriptionRouter(
    { primary, fallback: config.transcriptionFallback, localOnly: currentConfig.privacyMode === 'local-only' || config.privacyMode === 'local-only', beforeAttempt: provider => assertPrivacy(readAiConfig(sqlite), provider) },
    { mistralApiKey: settings.mistralApiKey, deepgramApiKey: settings.deepgramApiKey, openaiApiKey: settings.openaiApiKey, assemblyaiApiKey: settings.assemblyaiApiKey },
  );
  const options = { model: config.transcriptionModel || undefined, language: config.transcriptionLanguage, diarize: config.transcriptionDiarize, vocabulary: config.transcriptionVocabulary, channelSpeakers: recording.sourceProvider === 'meeting' };
  const startedAt = new Date().toISOString();
  const result = await router.transcribeFile(filePath, { ...options, signal: job.signal, checkpoint: job.checkpoint, onCheckpoint: job.saveCheckpoint });
  job.signal.throwIfAborted();

  if (result.success) {
    // Name speakers already known from earlier recordings; their voiceprints are kept once this transcript is current.
    const speakers = new SpeakerIdentity(sqlite);
    const identified = speakers.identify(result.segments, (result.metadata?.speakerEmbeddings ?? {}) as Record<number, number[]>,
      typeof result.metadata?.selfSpeaker === 'number' ? result.metadata.selfSpeaker : undefined);
    const documentUpdated = saveGeneratedTranscript({
      recordingId,
      fullText: result.fullText,
      segments: identified.segments,
      wordCount: result.wordCount,
      speakerCount: result.speakerCount,
      confidence: result.confidence,
      fingerprint: data.fingerprint,
      generationId: job.id,
      provenance: { provider: result.engine, model: result.metadata?.model ?? null, fingerprint: data.fingerprint, options, startedAt, completedAt: new Date().toISOString(), usage: result.metadata?.usage ?? null, language: result.metadata?.language ?? null },
    });

    if (documentUpdated) speakers.store(recordingId, identified.rows);

    if (documentUpdated && settings.autoSummarize === 'true') {
      await db.update(recordings).set({ status: 'summarizing' }).where(eq(recordings.id, recordingId));
      try {
        const { recordingAnalyzer } = await import('./analysis/analyzer');
        await recordingAnalyzer.analyze(recordingId, true);
      } catch (error) {
        console.error(`[Job] Auto-summary failed for ${recordingId}:`, error);
      }
    }

    await db.update(recordings).set({
      status: 'complete',
      processedAt: new Date().toISOString(),
      ...(result.duration > 0 ? { durationSeconds: Math.round(result.duration) } : {}),
      errorMessage: null,
    }).where(eq(recordings.id, recordingId));

    console.log(`[Job] Recording ${recordingId} transcribed: ${result.wordCount} words, ${result.speakerCount} speakers (${result.engine})`);
  } else {
    throw new Error(result.error || 'Transcription failed.');
  }
  } catch (error) {
    await db.update(recordings).set({ status: 'failed', errorMessage: job.signal.aborted ? 'Processing cancelled.' : error instanceof Error ? error.message : 'Transcription failed.' }).where(eq(recordings.id, recordingId));
    throw error;
  }
});

jobQueue.register('forward-recording', async (data: { recordingId: string }) => {
  await forwardRecordingWithRetry(data.recordingId);
});

// ============================================
// Create Hono app
// ============================================

const app = new Hono();

app.use('*', cors({
  origin: origin => {
    if (!origin) return '';
    try {
      const url = new URL(origin);
      const isLocalDevelopment = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      const isTauriOrigin = origin === 'tauri://localhost' || url.hostname === 'tauri.localhost';
      return isLocalDevelopment || isTauriOrigin ? origin : '';
    } catch {
      return '';
    }
  },
  allowHeaders: ['Content-Type', 'Range', 'X-OpenPlod-Token'],
  exposeHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range'],
}));
app.use('*', logger());
app.use('/api/*', apiAccess);

// Health/info
app.get('/health', (c) => c.json({ status: 'ok', jobs: jobQueue.getStats() }));
app.get('/api/info', (c) => c.json({
  name: 'OpenPlod',
  version: packageInfo.version,
  status: 'ok',
  engines: transcriptionRouter.status(),
}));

// API routes
app.route('/api/recordings', recordingsApi);
app.route('/api/plaud', plaudApi);
app.route('/api/mobile', mobileApi);
app.route('/api/transcripts', transcriptsApi);
const organizer = new OrganizerStore(sqlite);
app.route('/api/v1/jobs', createJobsApi(jobQueue, sqlite));
app.route('/api/v1', createOrganizerApi(organizer));
app.route('/api/ai', createRecordingAiApi(new RecordingAi(organizer)));
app.route('/api/ai-settings', createAiSettingsApi(sqlite));
const meetings = new MeetingRecorder({ database: sqlite, spawnBridge: spawnMeetingBridge, finalize: finalizeMeeting, stagingDirectory: meetingStagingDirectory });
app.route('/api/meetings', createMeetingsApi(meetings));
app.route('/api/speakers', createSpeakersApi(sqlite));
const obsidian = new ObsidianExporter(sqlite);
app.route('/api/obsidian', createObsidianApi(obsidian));
// Automatic export: notes follow finished transcripts, summaries and edits within seconds.
const exportToObsidian = () => void obsidian.run({ onlyIfAuto: true }).catch(error => console.error('[Obsidian] Export failed:', error));
setInterval(exportToObsidian, 15000).unref();

// Settings
app.get('/api/settings', async (c) => {
  const settings = await db.select().from(userSettings);
  const values = Object.fromEntries(settings.map(setting => [setting.key, setting.value]));
  return c.json({
    success: true,
    data: {
      transcriptionEngine: readAiConfig(sqlite).transcriptionEngine,
      syncFolderPath: values.syncFolderPath || '~/Documents/PlaudSync',
      autoTranscribe: values.autoTranscribe ?? 'true',
      autoSummarize: values.autoSummarize ?? 'false',
      autoImport: values.autoImport ?? 'false',
      plaudRecordingTypes: values.plaudRecordingTypes ?? '["class","meeting","conversation","other"]',
      deleteSourceAfterImport: values.deleteSourceAfterImport ?? 'false',
      openWhistleForwarding: values.openWhistleForwarding ?? 'false',
      openWhistleBaseUrl: values.openWhistleBaseUrl ?? '',
      openWhistleAgentId: values.openWhistleAgentId ?? '',
      openWhistleApiKeyConfigured: Boolean(values.openWhistleApiKey),
      mistralApiKeyConfigured: Boolean(values.mistralApiKey),
      deepgramApiKeyConfigured: Boolean(values.deepgramApiKey),
    },
  });
});

app.put('/api/settings/:key', async (c) => {
  const key = c.req.param('key');
  const allowedKeys = new Set([
    'transcriptionEngine',
    'mistralApiKey',
    'deepgramApiKey',
    'syncFolderPath',
    'autoTranscribe',
    'autoSummarize',
    'autoImport',
    'plaudRecordingTypes',
    'deleteSourceAfterImport',
    'openWhistleForwarding',
    'openWhistleBaseUrl',
    'openWhistleApiKey',
    'openWhistleAgentId',
  ]);
  if (!allowedKeys.has(key)) return c.json({ success: false, error: 'Unknown setting' }, 400);
  const { value } = await c.req.json();
  if (key === 'transcriptionEngine') {
    if (!['whisper', 'mistral', 'deepgram', 'openai', 'assemblyai'].includes(value)) return c.json({ success: false, error: 'Unknown transcription provider.' }, 400);
    const config = readAiConfig(sqlite);
    if (config.privacyMode === 'local-only' && value !== 'whisper') return c.json({ success: false, error: 'Local-only mode blocks cloud transcription.' }, 400);
    config.transcriptionEngine = value;
    config.transcriptionModel = ''; config.transcriptionDiarize = false; config.transcriptionVocabulary = [];
    await db.insert(userSettings).values({ key: 'aiConfig', value: JSON.stringify(config) }).onConflictDoUpdate({ target: userSettings.key, set: { value: JSON.stringify(config) } });
  }
  await db.insert(userSettings).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: userSettings.key, set: { value: String(value), updatedAt: new Date().toISOString() } });
  return c.json({ success: true });
});

// Jobs
app.get('/api/jobs', (c) => c.json({ success: true, data: jobQueue.getJobs().map(({ data, ...job }) => ({ ...job, recordingId: (data as any).recordingId, provider: (data as any).config?.transcriptionEngine })), stats: jobQueue.getStats() }));
app.post('/api/jobs/:id/cancel', c => c.json({ success: jobQueue.cancel(c.req.param('id')) }));
app.post('/api/jobs/:id/resume', c => c.json({ success: jobQueue.resume(c.req.param('id')) }));
app.patch('/api/jobs/:id', async c => { const body = await c.req.json(); return c.json({ success: jobQueue.setPriority(c.req.param('id'), body.priority) }); });

// Transcription engine status
app.get('/api/engines', (c) => c.json({ success: true, data: new TranscriptionRouter({}, readSettings(sqlite)).status() }));

// Search across transcripts
app.get('/api/search', async (c) => {
  const q = c.req.query('q') || '';
  if (q.length < 2) return c.json({ success: true, data: [] });

  try {
    return c.json({ success: true, data: searchTranscripts(q) });
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Serve frontend static files
app.use('/*', serveStatic({ root: './web/dist' }));
app.get('/*', serveStatic({ path: './web/dist/index.html' }));

// ============================================
// Start folder watcher + server
// ============================================

async function startFolderSync() {
  const savedSettings = await db.select().from(userSettings);
  const settings = Object.fromEntries(savedSettings.map(setting => [setting.key, setting.value]));
  // Manual folder import must not request Documents access during Bluetooth-only startup.
  if (settings.autoImport !== 'true') {
    console.log('[Startup] Automatic folder import is disabled');
    return;
  }
  const watcher = new FolderWatcher(await configuredSyncPath() ?? undefined);
  if (!watcher.isConfigured()) return;

  watcher.startWatching();
  const result = await watcher.syncAll();
  console.log(`[Startup] Folder sync: ${result.added} added, ${result.skipped} skipped`);
  // File events do not arrive for files another device writes to a network share (e.g. the iOS
  // companion uploading to a NAS mounted over SMB), so rescan every minute; known files are skipped
  // by size and modification time without being read again.
  setInterval(async () => {
    try {
      const [enabled] = await db.select({ value: userSettings.value }).from(userSettings).where(eq(userSettings.key, 'autoImport')).limit(1);
      if (enabled?.value !== 'true') return;
      const rescan = await watcher.syncAll();
      if (rescan.added) console.log(`[Folder] Rescan: ${rescan.added} added`);
    } catch (error) { console.error('[Folder] Rescan failed:', error); }
  }, 60000).unref();
}

void startFolderSync().catch(error => console.error('[Startup] Folder sync failed:', error));
// Sync when the recorder's beacon is heard; poll only where the bridge cannot listen (the Swift fallback).
plaudWatcher.start();
setInterval(() => { if (!plaudWatcher.active()) void automaticPlaud.tick(); }, 60000).unref();
// Meeting detection only runs on a Mac with the bundled helper; elsewhere it reports unavailable.
if (process.platform === 'darwin') {
  meetings.start();
  setInterval(() => meetings.tick(), 2000).unref();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { meetings.shutdown(); setTimeout(() => process.exit(0), 1500); });
}
// 30-day Trash retention must hold for a long-running server too, not only at startup.
function purgeTrash() {
  try { organizer.purgeExpired(); } catch (error) { console.error('[Retention] Note trash purge failed:', error); }
  void purgeExpiredTrash().then(count => {
    if (count > 0) console.log(`[Retention] Purged ${count} expired recording(s)`);
  }).catch(error => console.error('[Retention] Trash purge failed:', error));
}
purgeTrash();
setInterval(purgeTrash, 6 * 3600 * 1000).unref();

const port = parseInt(process.env.PORT || '3487', 10);
const hostname = process.env.HOST || '127.0.0.1';
console.log(`[PlaudApp] Starting on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  // Bluetooth discovery can take up to 35 seconds before returning a result.
  idleTimeout: 60,
  fetch: app.fetch,
};
