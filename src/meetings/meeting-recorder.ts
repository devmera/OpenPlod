import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { importRecordingFile, incomingDirectory } from '../library/recording-library';
import { queueRecordingProcessing } from '../library/processing';

/**
 * Meeting recording on the Mac (roadmap: automatic capture next to Plaud imports).
 *
 * `meeting-bridge` (src-tauri/meeting-bridge) is a small Swift helper that reports
 * which meeting apps hold the microphone and records mic + system audio on request.
 * Every decision lives here so it is testable: when to start (an enabled app has
 * held the mic for a few seconds), when to stop (it let go for a while), and what
 * happens to the finished file (converted to .m4a, imported into the vault, and
 * routed through the normal transcription settings).
 *
 * Nothing is recorded unless the owner turns automatic recording on or presses
 * Record. Audio never leaves the Mac except through the processing route the owner
 * already configured for every other recording.
 */

export type MeetingApp = { id: string; name: string };
export const MEETING_APPS: MeetingApp[] = [
  { id: 'zoom', name: 'Zoom' }, { id: 'teams', name: 'Microsoft Teams' }, { id: 'slack', name: 'Slack' },
  { id: 'webex', name: 'Webex' }, { id: 'facetime', name: 'FaceTime' }, { id: 'discord', name: 'Discord' },
  { id: 'whatsapp', name: 'WhatsApp' }, { id: 'tuple', name: 'Tuple' }, { id: 'lark', name: 'Lark / Feishu' },
  { id: 'browser', name: 'Browser call' },
];

export type BridgeEvent =
  | { event: 'ready' }
  | { event: 'apps'; apps: MeetingApp[] }
  | { event: 'started'; path: string }
  | { event: 'stopped'; path: string; durationSeconds: number; reason: string }
  | { event: 'error'; message: string }
  | { event: 'exit' };

export interface MeetingBridge {
  start(path: string, label: string): void;
  stop(): void;
  close(): void;
}

export type MeetingImport = { recordingId: string; title: string; app: string | null; durationSeconds: number; importedAt: string };

type Active = { app: MeetingApp | null; path: string; startedAt: number; recording: boolean };

export type MeetingStatus = {
  available: boolean;
  reason: string | null;
  autoRecord: boolean;
  enabledApps: string[];
  apps: (MeetingApp & { enabled: boolean; active: boolean })[];
  recording: null | { app: MeetingApp | null; startedAt: string; starting: boolean };
  error: string | null;
  recent: MeetingImport[];
};

/** An app must hold the mic this long before we start (avoids a mic test) ... */
export const START_AFTER_MS = 3_000;
/** ... and be gone this long before we stop (apps briefly release the mic when switching devices). */
export const STOP_AFTER_MS = 10_000;
/** Plaud drops files under 3 s too; they are always accidental. */
export const MIN_DURATION_SECONDS = 3;
/** The in-app recorder holds automatic recording off; a forgotten hold must not disable it forever. */
const HOLD_MS = 4 * 3600_000;

export type MeetingDependencies = {
  database: Database;
  /** Spawns the helper; returns null when it is not installed on this machine. */
  spawnBridge: (onEvent: (event: BridgeEvent) => void) => MeetingBridge | null;
  /** Converts, imports and queues processing for a finished file. */
  finalize: (params: { path: string; app: MeetingApp | null; startedAt: Date; durationSeconds: number }) => Promise<MeetingImport | null>;
  stagingDirectory: () => string;
  now?: () => number;
};

export class MeetingRecorder {
  private bridge: MeetingBridge | null = null;
  private unavailable: string | null = null;
  private detected: MeetingApp[] = [];
  private firstSeen = new Map<string, number>();
  private lastSeen = 0;
  private active: Active | null = null;
  /** The owner stopped an automatic recording mid-call: don't restart until that app lets go. */
  private suppressed: string | null = null;
  private holdUntil = 0;
  private error: string | null = null;
  private restartAt = 0;
  private restarts = 0;
  private finalizing: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private deps: MeetingDependencies) {
    this.now = deps.now ?? Date.now;
    deps.database.exec(`CREATE TABLE IF NOT EXISTS meeting_imports (recording_id TEXT PRIMARY KEY, title TEXT NOT NULL,
      app TEXT, duration_seconds REAL NOT NULL, imported_at TEXT NOT NULL)`);
  }

  // ---- settings -------------------------------------------------------------

  private setting(key: string): string | undefined {
    if (!this.deps.database.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").get()) return undefined;
    return (this.deps.database.query('SELECT value FROM user_settings WHERE key=?').get(key) as { value: string } | null)?.value;
  }
  private save(key: string, value: string) {
    this.deps.database.query(`INSERT INTO user_settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
  }
  autoRecord() { return this.setting('meetingAutoRecord') === 'true'; }
  enabledApps(): string[] {
    try {
      const parsed = JSON.parse(this.setting('meetingApps') ?? 'null');
      if (Array.isArray(parsed)) return parsed.filter(id => MEETING_APPS.some(app => app.id === id));
    } catch { /* fall through to every app */ }
    return MEETING_APPS.map(app => app.id);
  }
  configure(input: { autoRecord?: boolean; enabledApps?: string[] }) {
    if (input.autoRecord !== undefined) {
      if (input.autoRecord) this.ensureBridge();
      if (input.autoRecord && this.unavailable) throw new Error(this.unavailable);
      this.save('meetingAutoRecord', String(input.autoRecord));
    }
    if (input.enabledApps) {
      const known = input.enabledApps.filter(id => MEETING_APPS.some(app => app.id === id));
      this.save('meetingApps', JSON.stringify([...new Set(known)]));
    }
    this.tick();
    return this.status();
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Starts the helper and imports anything a crash left behind. */
  start() {
    this.recoverStaging();
    this.ensureBridge();
  }

  shutdown() {
    this.bridge?.close();
    this.bridge = null;
  }

  private ensureBridge() {
    if (this.bridge || this.now() < this.restartAt) return;
    try {
      this.bridge = this.deps.spawnBridge(event => this.onEvent(event));
      this.unavailable = this.bridge ? null : 'Meeting recording needs the OpenPlod Mac app on macOS 14.2 or later.';
    } catch (error) {
      this.bridge = null;
      this.unavailable = error instanceof Error ? error.message : 'The meeting recorder could not start.';
    }
  }

  /** Called every couple of seconds; also after each helper event. */
  tick() {
    const now = this.now();
    if (!this.bridge && !this.unavailable) this.ensureBridge();
    else if (!this.bridge && this.restartAt && now >= this.restartAt) this.ensureBridge();
    const ids = new Set(this.detected.map(app => app.id));
    for (const id of [...this.firstSeen.keys()]) if (!ids.has(id)) this.firstSeen.delete(id);
    for (const id of ids) if (!this.firstSeen.has(id)) this.firstSeen.set(id, now);
    if (this.suppressed && !ids.has(this.suppressed)) this.suppressed = null;

    const active = this.active;
    if (active) {
      if (!active.app || !active.recording) return; // manual recordings stop when the owner says so
      if (ids.has(active.app.id)) this.lastSeen = now;
      else if (now - Math.max(this.lastSeen, active.startedAt) >= STOP_AFTER_MS) this.stop();
      return;
    }

    if (!this.autoRecord() || now < this.holdUntil || !this.bridge) return;
    const enabled = new Set(this.enabledApps());
    const ready = this.detected
      .filter(app => enabled.has(app.id) && app.id !== this.suppressed)
      .filter(app => now - (this.firstSeen.get(app.id) ?? now) >= START_AFTER_MS)
      // Prefer a dedicated app over "browser" when both hold the mic.
      .sort((a, b) => Number(a.id === 'browser') - Number(b.id === 'browser'));
    if (ready[0]) this.begin(ready[0]);
  }

  // ---- commands --------------------------------------------------------------

  startManually() {
    this.ensureBridge();
    if (!this.bridge) throw new Error(this.unavailable ?? 'The meeting recorder is unavailable.');
    if (this.active) throw new Error('A meeting is already being recorded.');
    this.begin(null);
    return this.status();
  }

  stop() {
    if (!this.active) return this.status();
    const { app } = this.active;
    // Stopping an automatic recording while the call continues means "not this call".
    if (app && this.detected.some(candidate => candidate.id === app.id)) this.suppressed = app.id;
    this.bridge?.stop();
    return this.status();
  }

  /** The in-app recorder is running: its own microphone use is not a meeting. */
  hold(active: boolean) {
    this.holdUntil = active ? this.now() + HOLD_MS : 0;
    return this.status();
  }

  private begin(app: MeetingApp | null) {
    const startedAt = this.now();
    const directory = this.deps.stagingDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${startedAt}-${app?.id ?? 'manual'}.caf`);
    this.active = { app, path, startedAt, recording: false };
    this.lastSeen = startedAt;
    this.error = null;
    this.bridge!.start(path, app?.name ?? 'meeting');
  }

  // ---- helper events ---------------------------------------------------------

  onEvent(event: BridgeEvent) {
    switch (event.event) {
      case 'ready': this.restarts = 0; break;
      case 'apps': this.detected = event.apps.filter(app => MEETING_APPS.some(known => known.id === app.id)); break;
      case 'started':
        if (this.active?.path === event.path) this.active.recording = true;
        break;
      case 'stopped': {
        const active = this.active?.path === event.path ? this.active : null;
        this.active = null;
        if (active?.app && (event.reason === 'notification' || event.reason === 'sleep')
          && this.detected.some(app => app.id === active.app!.id)) this.suppressed = active.app.id;
        this.enqueueFinalize(event.path, active?.app ?? appFromStagingName(event.path), new Date(active?.startedAt ?? this.now()), event.durationSeconds);
        break;
      }
      case 'error':
        this.error = event.message;
        // A failed start: don't retry the same call every two seconds.
        if (this.active && !this.active.recording) {
          if (this.active.app) this.suppressed = this.active.app.id;
          this.active = null;
        }
        break;
      case 'exit': {
        this.bridge = null;
        this.detected = [];
        const orphan = this.active;
        this.active = null;
        // PCM CAF stays readable after a crash; import what was captured.
        if (orphan?.recording && existsSync(orphan.path)) this.enqueueFinalize(orphan.path, orphan.app, new Date(orphan.startedAt), null);
        this.restartAt = this.now() + Math.min(5 * 60_000, 2_000 * 2 ** Math.min(this.restarts++, 7));
        break;
      }
    }
    if (event.event !== 'exit') this.tick();
  }

  private enqueueFinalize(path: string, app: MeetingApp | null, startedAt: Date, durationSeconds: number | null) {
    this.finalizing = this.finalizing.then(async () => {
      const seconds = durationSeconds ?? estimateCafSeconds(path);
      if (seconds < MIN_DURATION_SECONDS) { removeQuietly(path); return; }
      try {
        const imported = await this.deps.finalize({ path, app, startedAt, durationSeconds: seconds });
        if (imported) this.deps.database.query('INSERT OR IGNORE INTO meeting_imports VALUES (?,?,?,?,?)')
          .run(imported.recordingId, imported.title, imported.app, imported.durationSeconds, imported.importedAt);
        this.deps.database.query('DELETE FROM meeting_imports WHERE recording_id NOT IN (SELECT recording_id FROM meeting_imports ORDER BY imported_at DESC LIMIT 20)').run();
      } catch (error) {
        // Keep the staging file; the next start retries it.
        this.error = `Meeting audio kept for retry: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    return this.finalizing;
  }

  /** Imports staging files left by a crash or a failed earlier import. */
  recoverStaging() {
    const directory = this.deps.stagingDirectory();
    if (!existsSync(directory)) return this.finalizing;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (!name.endsWith('.caf') || path === this.active?.path) continue;
      const startedAt = Number(name.split('-')[0]);
      this.enqueueFinalize(path, appFromStagingName(path), new Date(Number.isFinite(startedAt) && startedAt > 0 ? startedAt : statSync(path).mtimeMs), null);
    }
    return this.finalizing;
  }

  /** Resolves once queued imports have finished (tests). */
  settled() { return this.finalizing; }

  status(): MeetingStatus {
    const enabled = new Set(this.enabledApps());
    const detected = new Set(this.detected.map(app => app.id));
    return {
      available: Boolean(this.bridge),
      reason: this.bridge ? null : this.unavailable ?? 'The meeting recorder is restarting.',
      autoRecord: this.autoRecord(),
      enabledApps: [...enabled],
      apps: MEETING_APPS.map(app => ({ ...app, enabled: enabled.has(app.id), active: detected.has(app.id) })),
      recording: this.active ? { app: this.active.app, startedAt: new Date(this.active.startedAt).toISOString(), starting: !this.active.recording } : null,
      error: this.error,
      recent: this.deps.database.query(`SELECT recording_id AS recordingId, title, app, duration_seconds AS durationSeconds,
        imported_at AS importedAt FROM meeting_imports ORDER BY imported_at DESC LIMIT 10`).all() as MeetingImport[],
    };
  }
}

function appFromStagingName(path: string): MeetingApp | null {
  const id = path.split('/').pop()?.replace(/\.caf$/, '').split('-').slice(1).join('-');
  return MEETING_APPS.find(app => app.id === id) ?? null;
}

function removeQuietly(path: string) { try { unlinkSync(path); } catch { /* already gone */ } }

/** 16-bit stereo 48 kHz PCM: duration from the file size, header ignored (it may be unfinished). */
function estimateCafSeconds(path: string) {
  try { return Math.max(0, statSync(path).size - 4096) / (48_000 * 2 * 2); } catch { return 0; }
}

// ---- production wiring -------------------------------------------------------

export const MEETING_BRIDGE_BINARY = 'meeting-bridge';

/** The helper is bundled next to the server; development builds use `bun run build:meeting`. */
export function findMeetingBridge(): string | null {
  if (process.platform !== 'darwin') return null;
  const override = process.env.OPENPLOD_MEETING_BRIDGE;
  if (override) return existsSync(override) ? override : null;
  const candidates = [
    join(dirname(process.execPath), MEETING_BRIDGE_BINARY),
    join(process.cwd(), 'src-tauri', 'meeting-bridge', 'build', MEETING_BRIDGE_BINARY),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

export function spawnMeetingBridge(onEvent: (event: BridgeEvent) => void): MeetingBridge | null {
  const binary = findMeetingBridge();
  if (!binary) return null;
  const child = Bun.spawn([binary], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  const send = (message: object) => {
    try { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush(); } catch { /* exit event follows */ }
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line) as BridgeEvent); } catch { /* ignore malformed helper output */ }
      }
    }
  })().finally(() => { void child.exited.then(() => onEvent({ event: 'exit' })); });
  return {
    start: (path, label) => send({ cmd: 'start', path, label }),
    stop: () => send({ cmd: 'stop' }),
    // Closing stdin lets the helper finish an open file before it exits.
    close: () => { try { child.stdin.end(); } catch { /* already closed */ } },
  };
}

export function meetingStagingDirectory() {
  return join(incomingDirectory(), 'meetings');
}

/** Converts the PCM capture to AAC, imports it into the vault and queues processing. */
export async function finalizeMeeting(params: { path: string; app: MeetingApp | null; startedAt: Date; durationSeconds: number }): Promise<MeetingImport> {
  const m4a = params.path.replace(/\.caf$/, '.m4a');
  const convert = Bun.spawn(['/usr/bin/afconvert', '-f', 'm4af', '-d', 'aac', params.path, m4a], { stdout: 'ignore', stderr: 'pipe' });
  if (await convert.exited !== 0) {
    removeQuietly(m4a);
    throw new Error(`audio conversion failed (${(await new Response(convert.stderr).text()).trim() || convert.exitCode})`);
  }
  const title = meetingTitle(params.app, params.startedAt);
  const { recording, added } = await importRecordingFile({
    sourcePath: m4a,
    originalFilename: `${title}.m4a`,
    provenance: { sourceProvider: 'meeting', sourceTransport: 'capture', recordedAt: params.startedAt.toISOString() },
    metadata: {
      recordingType: 'meeting',
      tags: ['meeting'],
      context: `${params.app ? `${params.app.name} call` : 'Meeting'} recorded on this Mac. Left channel: microphone; right channel: other participants.`,
      durationMs: Math.round(params.durationSeconds * 1000),
    },
  });
  if (added) await queueRecordingProcessing({ recordingId: recording.id, filePath: recording.filePath });
  removeQuietly(m4a);
  removeQuietly(params.path);
  return { recordingId: recording.id, title, app: params.app?.name ?? null, durationSeconds: params.durationSeconds, importedAt: new Date().toISOString() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Zoom meeting 13 Oct 2026 14.02", in local time; no ICU formatting so every runtime agrees. */
export function meetingTitle(app: MeetingApp | null, startedAt: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const when = `${startedAt.getDate()} ${MONTHS[startedAt.getMonth()]} ${startedAt.getFullYear()} ${pad(startedAt.getHours())}.${pad(startedAt.getMinutes())}`;
  return `${app ? `${app.name} meeting` : 'Meeting'} ${when}`.replace(/[\\/:*?"<>|]/g, ' ');
}
