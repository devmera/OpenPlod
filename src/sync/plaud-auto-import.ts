import type { Database } from 'bun:sqlite';
import { plaudTransfers } from './plaud-transfers';
import { directPlaudConfigured, importDirectPlaudRecording, readDirectPlaudRecordings } from './plaud-direct';

export class PlaudAutoImport {
  private running = false;
  private previous = new Map<string, number>();
  private lastChecked: string | null = null;
  private error: string | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastSync: { at: string; imported: number } | null = null;
  /** The recorder's list from the last background round, so the UI can show it without connecting. */
  lastListing: { serial: string; checkedAt: string; sessions: { sessionId: number; size: number; scene: number; timezone: number }[] } | null = null;
  constructor(private database: Database, private adapter = { configured: directPlaudConfigured, list: readDirectPlaudRecordings, import: importDirectPlaudRecording }) {
    database.exec(`CREATE TABLE IF NOT EXISTS plaud_import_events (id INTEGER PRIMARY KEY AUTOINCREMENT, recording_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  enabled() { return (this.database.query("SELECT value FROM user_settings WHERE key='directPlaudAutoImport'").get() as { value: string } | null)?.value === 'true'; }
  set(enabled: boolean) {
    if (enabled && !this.adapter.configured()) throw new Error('Authorize this Note Pro on the Mac first.');
    this.database.query("INSERT INTO user_settings(key,value) VALUES('directPlaudAutoImport',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled));
    return this.status();
  }
  status() { return { enabled: this.enabled(), running: this.running, lastChecked: this.lastChecked, lastSync: this.lastSync, error: this.error,
    events: this.database.query('SELECT id,recording_id AS recordingId,created_at AS createdAt FROM plaud_import_events ORDER BY id DESC LIMIT 10').all() }; }
  /**
   * One sync round. `settleMs` confirms within this connection which recordings
   * are complete (instead of waiting for the next round); `force` is "Sync now"
   * and skips the back-off after failures.
   */
  async tick(options: { settleMs?: number; force?: boolean } = {}) {
    if (this.running || !this.enabled() || (!options.force && Date.now() < this.retryAt)) return;
    this.running = true;
    let imported = 0;
    try {
      const result = await this.adapter.list(options.settleMs ? { settleMs: options.settleMs } : undefined); this.lastChecked = result.checkedAt;
      const settled = result.stable ? new Set(result.stable) : null;
      this.lastListing = { serial: result.serial, checkedAt: result.checkedAt, sessions: result.sessions };
      const observed = new Map<string, number>();
      const existing = new Set((this.database.query(
        `SELECT source_recording_id AS sourceId FROM recordings WHERE source_provider=? AND source_recording_id IS NOT NULL`,
      ).all('plaud') as { sourceId: string }[]).map(row => row.sourceId));
      // Show every recording this round will fetch as a queued row before the first transfer starts.
      plaudTransfers.queue(result.sessions.filter(session => session.size > 512
        && (settled?.has(session.sessionId) || this.previous.get(`${result.serial}:${session.sessionId}`) === session.size)
        && !existing.has(`${result.serial}:${session.sessionId}`)));
      for (const session of result.sessions) {
        const source = `${result.serial}:${session.sessionId}`; observed.set(source, session.size);
        if (!this.enabled()) break;
        // Import only recordings whose size held still (within this connection, or since the last round).
        if (session.size <= 512 || !(settled?.has(session.sessionId) || this.previous.get(source) === session.size)) continue;
        if (existing.has(source)) continue;
        const outcome = await this.adapter.import(session.sessionId);
        if (outcome.added || outcome.recording.sourceRecordingId === source) existing.add(source);
        if (outcome.added) {
          imported++;
          this.database.query('INSERT INTO plaud_import_events(recording_id,created_at) VALUES(?,?)').run(outcome.recording.id, new Date().toISOString());
        }
      }
      this.previous = observed; this.failures = 0; this.error = null; this.retryAt = 0;
      this.lastSync = { at: result.checkedAt, imported };
      this.database.query('DELETE FROM plaud_import_events WHERE id NOT IN (SELECT id FROM plaud_import_events ORDER BY id DESC LIMIT 100)').run();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Plaud automatic import unavailable.';
      this.retryAt = Date.now() + Math.min(15 * 60000, 30000 * 2 ** Math.min(this.failures++, 5));
    } finally { this.running = false; plaudTransfers.dropQueued(); }
  }
}
