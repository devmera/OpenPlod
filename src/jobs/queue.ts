import type { Database } from 'bun:sqlite';
import { sqlite } from '../db/client';
import { readAiConfig } from '../ai/config';

export interface Job<T = unknown> {
  id: string; type: string; data: T; status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  error?: string; createdAt: Date; startedAt?: Date; completedAt?: Date; priority: number;
  checkpoint?: { phase: string; remoteId?: string };
}
export type JobContext = { id: string; signal: AbortSignal; checkpoint?: Job['checkpoint']; saveCheckpoint: (checkpoint: NonNullable<Job['checkpoint']>) => void };
type JobHandler<T = unknown> = (data: T, context: JobContext) => Promise<void>;
const TERMINAL: Job['status'][] = ['complete', 'failed', 'cancelled'];
/** Finished jobs are kept this long for status and audit, then dropped on startup. */
const RETAIN_FINISHED_MS = 30 * 86400000;
const RETAIN_FINISHED_COUNT = 1000;

export class JobQueue {
  private jobs: Job[] = [];
  private handlers = new Map<string, JobHandler<any>>();
  private processing = false;
  private controllers = new Map<string, AbortController>();
  constructor(private database: Database) {
    database.exec('CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
    const rows = database.query('SELECT id, payload FROM processing_jobs ORDER BY rowid').all() as { id: string; payload: string }[];
    const loaded = rows.map(row => {
      const value = JSON.parse(row.payload);
      return { ...value, createdAt: new Date(value.createdAt), startedAt: value.startedAt ? new Date(value.startedAt) : undefined,
        completedAt: value.completedAt ? new Date(value.completedAt) : undefined } as Job;
    });
    // Without pruning, every job ever run stays in memory and is rescanned on each queue step.
    const finished = loaded.filter(job => TERMINAL.includes(job.status));
    const cutoff = Date.now() - RETAIN_FINISHED_MS;
    const expired = new Set(finished.filter((job, index) => index < finished.length - RETAIN_FINISHED_COUNT
      || (job.completedAt ?? job.createdAt).getTime() < cutoff).map(job => job.id));
    if (expired.size) database.query('DELETE FROM processing_jobs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify([...expired]));
    for (const job of loaded) {
      if (expired.has(job.id)) continue;
      if (job.status === 'running') {
        job.status = job.checkpoint?.remoteId ? 'pending' : 'failed';
        job.error = job.status === 'failed' ? 'Interrupted during processing. Provider outcome may be unknown; check usage before retrying.' : undefined;
        this.persist(job);
        // Otherwise the recording would show "transcribing" forever after a crash.
        if (job.status === 'failed' && job.type === 'summarize-recording') database.query("UPDATE recordings SET status='complete' WHERE id=? AND status IN ('pending','summarizing')")
          .run(String((job.data as { recordingId?: unknown }).recordingId));
        if (job.status === 'failed' && job.type === 'process-recording') database.query("UPDATE recordings SET status='failed', error_message=? WHERE id=? AND retention_state='active'")
          .run(job.error!, String((job.data as { recordingId?: unknown }).recordingId));
      }
      this.jobs.push(job);
    }
  }
  private persist(job: Job) { this.database.query('INSERT INTO processing_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, JSON.stringify(job)); }
  register<T>(type: string, handler: JobHandler<T>) { this.handlers.set(type, handler); queueMicrotask(() => { void this.processNext(); }); }
  async add<T>(type: string, data: T, priority = 0): Promise<Job<T>> {
    const input = data as Record<string, unknown>;
    const existing = typeof input.recordingId === 'string' ? this.activeJob(type, input.recordingId) : undefined;
    if (existing) return existing as Job<T>;
    let savedData = data;
    if (type === 'process-recording') {
      const recording = this.database.query('SELECT fingerprint FROM recordings WHERE id=?').get(String(input.recordingId)) as { fingerprint: string | null } | null;
      savedData = { ...input, config: input.config ?? readAiConfig(this.database), fingerprint: recording?.fingerprint ?? null } as T;
    }
    const job: Job<T> = { id: crypto.randomUUID(), type, data: savedData, priority, status: 'pending', createdAt: new Date() };
    this.persist(job); this.jobs.push(job);
    queueMicrotask(() => { void this.processNext(); });
    return job;
  }
  cancel(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['pending', 'running'].includes(job.status)) return false;
    job.status = 'cancelled'; job.completedAt = new Date();
    job.error = job.checkpoint?.remoteId ? 'Local polling cancelled. Remote processing may continue.' : 'Cancelled. Any submitted provider request may still be billed.';
    if (job.type === 'process-recording') this.database.query("UPDATE recordings SET status='failed',error_message='Processing cancelled.' WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    if (job.type === 'summarize-recording') this.database.query("UPDATE recordings SET status='complete' WHERE id=? AND status IN ('pending','summarizing')").run(String((job.data as any).recordingId));
    this.persist(job); this.controllers.get(id)?.abort(); return true;
  }
  resume(id: string) {
    const job = this.jobs.find(item => item.id === id);
    if (!job?.checkpoint?.remoteId || !['failed', 'cancelled'].includes(job.status) || this.controllers.has(id)) return false;
    const other = this.jobs.some(item => item.id !== id && ['pending', 'running'].includes(item.status) && (item.data as any).recordingId === (job.data as any).recordingId);
    if (other) return false;
    job.status = 'pending'; job.error = undefined; job.completedAt = undefined; this.persist(job);
    if (job.type === 'process-recording') this.database.query("UPDATE recordings SET status='pending',error_message=NULL WHERE id=? AND retention_state='active'").run(String((job.data as any).recordingId));
    queueMicrotask(() => { void this.processNext(); }); return true;
  }
  setPriority(id: string, priority: number) {
    const job = this.jobs.find(item => item.id === id && item.status === 'pending');
    if (!job || !Number.isInteger(priority) || priority < -10 || priority > 10) return false;
    job.priority = priority; this.persist(job); return true;
  }
  private async processNext() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const job = this.jobs.filter(j => j.status === 'pending' && this.handlers.has(j.type)).sort((a, b) => b.priority - a.priority)[0];
        if (!job) break;
        const controller = new AbortController(); this.controllers.set(job.id, controller);
        job.status = 'running'; job.startedAt = new Date(); this.persist(job);
        try {
          await this.handlers.get(job.type)!(job.data, { id: job.id, signal: controller.signal, checkpoint: job.checkpoint,
            saveCheckpoint: checkpoint => { job.checkpoint = checkpoint; this.persist(job); } });
          if (!controller.signal.aborted) job.status = 'complete';
        } catch (error) {
          if (!controller.signal.aborted) { job.status = 'failed'; job.error = error instanceof Error ? error.message : 'Processing failed.'; }
        } finally {
          job.completedAt = new Date(); this.persist(job); this.controllers.delete(job.id);
        }
      }
    } finally { this.processing = false; }
  }
  getJob(id: string) { return this.jobs.find(job => job.id === id); }
  /** The queued or running job of this type for a recording, if any. */
  activeJob(type: string, recordingId: string) {
    return this.jobs.find(job => job.type === type && ['pending', 'running'].includes(job.status) && (job.data as { recordingId?: unknown })?.recordingId === recordingId);
  }
  /** Every retained job in submission order. Callers must not mutate it. */
  getAllJobs(): readonly Job[] { return this.jobs; }
  getJobs(status?: Job['status']) { return this.jobs.filter(job => !status || job.status === status).slice(-200); }
  getStats(): Record<Job['status'] | 'total', number> { return { total: this.jobs.length, ...Object.fromEntries(['pending', 'running', 'complete', 'failed', 'cancelled'].map(status => [status, this.jobs.filter(job => job.status === status).length])) } as Record<Job['status'] | 'total', number>; }
}
export const jobQueue = new JobQueue(sqlite);
