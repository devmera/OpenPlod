/**
 * Action items from summaries become tasks in the user's Todoist.
 *
 * Only tasks the summary marked as the user's own are sent automatically; any other action item can be
 * sent by hand. A task's identity is its recording plus the transcript passage that proves it, never
 * the model's wording, so summarizing a recording again does not add the same task twice. Tasks are
 * created through the Sync API, whose command uuids Todoist refuses to run twice: a retry after a
 * timeout cannot duplicate a task either. Once sent, a task belongs to the user; OpenPlod never edits
 * or deletes it in Todoist.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const SYNC_URL = 'https://api.todoist.com/api/v1/sync';
export const LABEL = 'openplod';
/** Fixed namespaces. Changing either re-keys every task and would send them all again. */
const NS_TASK = '3d9f6c2a-8b41-4e7d-a5c0-6f2b19e84d17';
const NS_COMMAND = 'b7e14a90-2c6d-4f38-9e51-0a8d3c7f6b24';

function uuidv5(namespace: string, name: string): string {
  const hash = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Case, spacing and punctuation never make a different task. Frozen: changing it re-keys every task. */
export const normaliseEvidence = (evidence: string) => evidence.normalize('NFC').toLowerCase().replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/gu, ' ').trim();
export const taskKey = (recordingId: string, evidence: string) => uuidv5(NS_TASK, `${recordingId}\u0000${normaliseEvidence(evidence)}`);
const commandUuid = (key: string) => uuidv5(NS_COMMAND, key);
/** The same commitment quoted to a different length by a later summary. Short fragments never count. */
export function evidenceOverlaps(a: string, b: string, minLength = 30): boolean {
  const [x, y] = [normaliseEvidence(a), normaliseEvidence(b)].sort((p, q) => p.length - q.length);
  return x === y || (x.length >= minLength && y.includes(x));
}

export interface Command { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> }
type Status = 'ok' | { error?: string; error_tag?: string };
export interface TodoistProject { id: string; name: string; inbox: boolean }
export interface TodoistApi {
  sync(commands: Command[]): Promise<{ status: Record<string, Status>; tempIds: Record<string, string> }>;
  read(): Promise<{ projects: TodoistProject[]; labels: string[] }>;
  /** Ids of the user's tasks that are still open; a task missing here was completed or deleted. */
  openTaskIds(): Promise<Set<string>>;
}

export class TodoistClient implements TodoistApi {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}
  private async post(body: Record<string, string>) {
    const response = await this.fetchImpl(SYNC_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401 || response.status === 403) throw new Error('Todoist rejected the API token.');
    if (!response.ok) throw new Error(`Todoist returned HTTP ${response.status}.`);
    return await response.json() as Record<string, unknown>;
  }
  async sync(commands: Command[]) {
    if (!commands.length) return { status: {}, tempIds: {} };
    const body = await this.post({ commands: JSON.stringify(commands) });
    return { status: (body.sync_status ?? {}) as Record<string, Status>, tempIds: (body.temp_id_mapping ?? {}) as Record<string, string> };
  }
  async read() {
    const body = await this.post({ sync_token: '*', resource_types: '["projects","labels"]' });
    const projects = ((body.projects ?? []) as { id: string; name: string; inbox_project?: boolean; is_deleted?: boolean; is_archived?: boolean }[])
      .filter(project => !project.is_deleted && !project.is_archived).map(project => ({ id: project.id, name: project.name, inbox: Boolean(project.inbox_project) }));
    return { projects, labels: ((body.labels ?? []) as { name: string; is_deleted?: boolean }[]).filter(label => !label.is_deleted).map(label => label.name) };
  }
  async openTaskIds() {
    const body = await this.post({ sync_token: '*', resource_types: '["items"]' });
    return new Set(((body.items ?? []) as { id: string; checked?: boolean; is_deleted?: boolean }[]).filter(item => !item.checked && !item.is_deleted).map(item => item.id));
  }
}

const statusError = (status: Status | undefined) => status === undefined ? 'Todoist did not answer for this task.' : status === 'ok' ? '' : status.error || status.error_tag || 'Todoist rejected the task.';

export interface TodoistSettings { connected: boolean; projectId: string; auto: boolean; principal: string }
export interface SettingsInput { token?: string; projectId: string; auto: boolean; principal: string }
interface StoredTask { title: string; description?: string; assignee?: string; dueDate?: string; dueEvidence?: string; mine?: boolean; context: string }
/** `start` is where the quote behind the task begins in the audio, in seconds, when it can be found. */
export interface RecordingTask extends StoredTask { key: string; todoistId: string | null; sentAt: string | null; start: number | null; doneAt: string | null }
export interface MeetingTasks { recordingId: string; title: string; recordedAt: string | null; tasks: RecordingTask[] }

const words = (text: string) => text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
/**
 * Where a quote begins: the segment starting the run of up to three consecutive segments that holds
 * most of the quote's words. Of equally good runs the latest start wins, since earlier runs only add
 * unrelated lines before the quote. Null when under half the words are found.
 */
export function quoteStart(quote: string, segments: { start?: number; text?: string }[]): number | null {
  const wanted = words(quote);
  if (!wanted.length) return null;
  let best = -1, score = 0;
  segments.forEach((_, index) => {
    const bag = new Set(segments.slice(index, index + 3).flatMap(segment => words(segment.text ?? '')));
    const found = wanted.filter(word => bag.has(word)).length / wanted.length;
    if (found >= score) { best = index; score = found; }
  });
  const start = segments[best]?.start;
  return best !== -1 && score >= 0.5 && typeof start === 'number' ? start : null;
}
export interface SendResult { key: string; title: string; action: 'created' | 'already' | 'failed'; reason?: string }

const recordingTitle = (filename: string | null) => (filename || 'Recording').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[-_]+/g, ' ').trim();

/** What is needed to judge a task without opening the recording: why it exists and where it came from. */
export function describeTask(task: StoredTask, recording: { title: string; recordedAt: string | null }): string {
  const lines: string[] = [];
  if (task.description) lines.push(task.description, '');
  lines.push(`> ${task.context}`);
  if (task.dueEvidence) lines.push('', `Deadline as said: "${task.dueEvidence}"`);
  const when = recording.recordedAt ? new Date(recording.recordedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '';
  lines.push('', `From OpenPlod: ${recording.title}${stamp}`);
  return lines.join('\n');
}

/** Todoist reads a date without a time zone as floating local time, which is what was said in the meeting. */
const dueArgs = (dueDate?: string) => !dueDate ? {} : { due: { date: dueDate.includes('T') ? `${dueDate}:00` : dueDate } };

export class TodoistPublisher {
  private running = false;
  /** After a failed automatic send, wait before trying again rather than calling Todoist every cycle. */
  private retryAt = 0;
  lastRun: { at: string; results: SendResult[]; error?: string } | null = null;

  constructor(private sqlite: Database, private connect: (token: string) => TodoistApi = token => new TodoistClient(token)) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS todoist_tasks (task_key TEXT PRIMARY KEY, recording_id TEXT NOT NULL, evidence TEXT NOT NULL,
      title TEXT NOT NULL, todoist_id TEXT, sent_at TEXT NOT NULL)`);
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_todoist_tasks_recording ON todoist_tasks(recording_id)');
    // Ticked-off tasks, keyed like sent ones so a new summary of the same meeting keeps them ticked.
    sqlite.exec('CREATE TABLE IF NOT EXISTS task_done (task_key TEXT PRIMARY KEY, recording_id TEXT NOT NULL, evidence TEXT NOT NULL, done_at TEXT NOT NULL)');
  }

  private values(): Record<string, string> {
    const rows = this.sqlite.query("SELECT key, value FROM user_settings WHERE key IN ('todoistToken', 'todoistProjectId', 'todoistAuto', 'todoistAutoSince', 'principalName')").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }
  private set(key: string, value: string | null) {
    if (value === null) this.sqlite.query('DELETE FROM user_settings WHERE key = ?').run(key);
    else this.sqlite.query("INSERT INTO user_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, value);
  }
  private api(): TodoistApi {
    const token = this.values().todoistToken;
    if (!token) throw new Error('Connect Todoist in Settings first.');
    return this.connect(token);
  }

  settings(): TodoistSettings {
    const values = this.values();
    return { connected: Boolean(values.todoistToken), projectId: values.todoistProjectId ?? '', auto: values.todoistAuto === 'true', principal: values.principalName ?? '' };
  }

  /** A new token is checked against Todoist before it is stored. */
  async saveSettings(input: SettingsInput): Promise<TodoistSettings> {
    const token = input.token?.trim();
    if (token) await this.connect(token).read();
    const before = this.settings();
    this.sqlite.transaction(() => {
      if (token) this.set('todoistToken', token);
      this.set('todoistProjectId', input.projectId.trim() || null);
      this.set('principalName', input.principal.trim() || null);
      this.set('todoistAuto', String(input.auto));
      // Turning automatic sending on covers summaries from now on, never the whole back catalogue.
      if (input.auto && !before.auto) this.set('todoistAutoSince', new Date().toISOString());
    })();
    return this.settings();
  }

  disconnect(): TodoistSettings {
    this.sqlite.transaction(() => { for (const key of ['todoistToken', 'todoistAuto', 'todoistAutoSince']) this.set(key, null); })();
    return this.settings();
  }

  async projects(): Promise<TodoistProject[]> { return (await this.api().read()).projects; }

  /** A recording's action items, each with whether it is already in Todoist and where it was said. */
  tasks(recordingId: string): RecordingTask[] {
    const row = this.sqlite.query('SELECT extracted_tasks AS tasks, segments FROM transcripts WHERE recording_id = ?').get(recordingId) as { tasks: string | null; segments: string | null } | null;
    return row ? this.withState(recordingId, row.tasks, row.segments) : [];
  }

  /** Every active recording's action items, newest recording first. */
  allTasks(): MeetingTasks[] {
    const rows = this.sqlite.query(`SELECT r.id, r.original_filename AS filename, COALESCE(r.recorded_at, r.uploaded_at) AS recordedAt, t.extracted_tasks AS tasks, t.segments
      FROM recordings r JOIN transcripts t ON t.recording_id = r.id
      WHERE r.retention_state = 'active' AND t.extracted_tasks IS NOT NULL AND t.extracted_tasks != '[]'
      ORDER BY COALESCE(r.recorded_at, r.uploaded_at) DESC`).all() as { id: string; filename: string | null; recordedAt: string | null; tasks: string; segments: string | null }[];
    return rows.map(row => ({ recordingId: row.id, title: recordingTitle(row.filename), recordedAt: row.recordedAt, tasks: this.withState(row.id, row.tasks, row.segments) }))
      .filter(meeting => meeting.tasks.length);
  }

  private withState(recordingId: string, tasksJson: string | null, segmentsJson: string | null): RecordingTask[] {
    let stored: StoredTask[] = [], segments: { start?: number; text?: string }[] = [];
    try { stored = tasksJson ? (JSON.parse(tasksJson) as StoredTask[]).filter(task => task?.title && task.context) : []; } catch { stored = []; }
    try { segments = segmentsJson ? JSON.parse(segmentsJson) : []; } catch { segments = []; }
    if (!Array.isArray(segments)) segments = [];
    const sent = this.sqlite.query('SELECT task_key AS key, evidence, todoist_id AS todoistId, sent_at AS sentAt FROM todoist_tasks WHERE recording_id = ?').all(recordingId) as
      { key: string; evidence: string; todoistId: string | null; sentAt: string }[];
    const done = this.sqlite.query('SELECT task_key AS key, evidence, done_at AS doneAt FROM task_done WHERE recording_id = ?').all(recordingId) as
      { key: string; evidence: string; doneAt: string }[];
    const find = <T extends { key: string; evidence: string }>(rows: T[], key: string, context: string) => rows.find(item => item.key === key) ?? rows.find(item => evidenceOverlaps(item.evidence, context));
    return stored.map(task => {
      const key = taskKey(recordingId, task.context), match = find(sent, key, task.context);
      return { ...task, key, todoistId: match?.todoistId ?? null, sentAt: match?.sentAt ?? null, start: quoteStart(task.context, segments), doneAt: find(done, key, task.context)?.doneAt ?? null };
    });
  }

  /**
   * Ticks a task off, or back on. A task in Todoist is completed or reopened there first, and nothing
   * changes here if Todoist refuses.
   */
  async setDone(recordingId: string, key: string, done: boolean): Promise<RecordingTask> {
    const task = this.tasks(recordingId).find(item => item.key === key);
    if (!task) throw new Error('Task not found. The recording may have been summarized again.');
    if (task.todoistId && this.settings().connected) {
      const { status } = await this.api().sync([{ type: done ? 'item_close' : 'item_uncomplete', uuid: randomUUID(), args: { id: task.todoistId } }]);
      const result = Object.values(status)[0];
      if (result !== 'ok') throw new Error(`Todoist could not ${done ? 'complete' : 'reopen'} the task: ${statusError(result)}`);
    }
    this.mark(recordingId, task, done);
    return this.tasks(recordingId).find(item => item.key === key)!;
  }

  private mark(recordingId: string, task: RecordingTask, done: boolean) {
    // Clears every row standing for this task, including one keyed on an earlier summary's quote.
    for (const row of this.sqlite.query('SELECT task_key AS key, evidence FROM task_done WHERE recording_id = ?').all(recordingId) as { key: string; evidence: string }[])
      if (row.key === task.key || evidenceOverlaps(row.evidence, task.context)) this.sqlite.query('DELETE FROM task_done WHERE task_key = ?').run(row.key);
    if (done) this.sqlite.query('INSERT INTO task_done(task_key, recording_id, evidence, done_at) VALUES(?, ?, ?, ?)').run(task.key, recordingId, task.context, new Date().toISOString());
  }

  private pulledAt = 0;
  /**
   * Takes completion from Todoist for tasks sent there: ticked off when Todoist no longer lists the task
   * as open, unticked when it was reopened. At most every 30 seconds; failures leave things as they are.
   */
  async pullCompletion(): Promise<void> {
    if (!this.settings().connected || Date.now() - this.pulledAt < 30000) return;
    this.pulledAt = Date.now();
    let open: Set<string>;
    try { open = await this.api().openTaskIds(); } catch { return; }
    for (const meeting of this.allTasks()) for (const task of meeting.tasks) {
      if (!task.todoistId) continue;
      const doneThere = !open.has(task.todoistId);
      if (doneThere !== Boolean(task.doneAt)) this.mark(meeting.recordingId, task, doneThere);
    }
  }

  /** Send the given action items, or every one marked as the user's, unless already sent. */
  async send(recordingId: string, keys?: string[]): Promise<SendResult[]> {
    const recording = this.sqlite.query('SELECT original_filename AS filename, recorded_at AS recordedAt, uploaded_at AS uploadedAt FROM recordings WHERE id = ?').get(recordingId) as
      { filename: string | null; recordedAt: string | null; uploadedAt: string | null } | null;
    if (!recording) throw new Error('Recording not found.');
    // Without keys: your open tasks. A task already ticked off is not sent unasked.
    const tasks = this.tasks(recordingId).filter(task => keys ? keys.includes(task.key) : task.mine === true && !task.doneAt);
    const results: SendResult[] = tasks.filter(task => task.sentAt).map(task => ({ key: task.key, title: task.title, action: 'already' }));
    // The same passage can back two titles in one summary; it is still one task.
    const pending = tasks.filter((task, index) => !task.sentAt && tasks.findIndex(other => other.key === task.key) === index);
    if (!pending.length) return results;
    const api = this.api(), { projectId } = this.settings();
    const { labels, projects } = await api.read();
    if (projectId && !projects.some(project => project.id === projectId)) throw new Error('The chosen Todoist project no longer exists. Pick another in Settings.');
    // Fresh uuids: a deleted label must be recreatable, and Todoist would replay a fixed uuid as a no-op.
    if (!labels.includes(LABEL)) await api.sync([{ type: 'label_add', uuid: randomUUID(), args: { name: LABEL } }]);
    const source = { title: recordingTitle(recording.filename), recordedAt: recording.recordedAt || recording.uploadedAt };
    const { status, tempIds } = await api.sync(pending.map(task => ({
      type: 'item_add', uuid: commandUuid(task.key), temp_id: task.key,
      args: { content: task.title, description: describeTask(task, source), labels: [LABEL], ...(projectId ? { project_id: projectId } : {}), ...dueArgs(task.dueDate) },
    })));
    const record = this.sqlite.query('INSERT OR IGNORE INTO todoist_tasks(task_key, recording_id, evidence, title, todoist_id, sent_at) VALUES(?, ?, ?, ?, ?, ?)');
    for (const task of pending) {
      const result = status[commandUuid(task.key)];
      if (result !== 'ok') { results.push({ key: task.key, title: task.title, action: 'failed', reason: statusError(result) }); continue; }
      record.run(task.key, recordingId, task.context, task.title, tempIds[task.key] ?? null, new Date().toISOString());
      results.push({ key: task.key, title: task.title, action: 'created' });
    }
    return results;
  }

  /** Recordings summarized since automatic sending was turned on that still have unsent tasks of the user's. */
  pending(): string[] {
    const { todoistAutoSince: since } = this.values();
    if (!since) return [];
    const rows = this.sqlite.query(`SELECT r.id FROM recordings r JOIN transcripts t ON t.recording_id = r.id
      WHERE r.retention_state = 'active' AND r.status = 'complete' AND t.analyzed_at >= ? AND t.extracted_tasks LIKE '%"mine":true%'`).all(since) as { id: string }[];
    return rows.map(row => row.id).filter(id => this.tasks(id).some(task => task.mine && !task.sentAt && !task.doneAt));
  }

  async run(): Promise<SendResult[]> {
    const settings = this.settings();
    if (this.running || !settings.connected || !settings.auto || Date.now() < this.retryAt) return [];
    this.running = true;
    const results: SendResult[] = [];
    try {
      for (const id of this.pending()) results.push(...await this.send(id));
      if (results.some(result => result.action === 'failed')) this.retryAt = Date.now() + 5 * 60000;
      if (results.length) this.lastRun = { at: new Date().toISOString(), results };
    } catch (error) {
      this.retryAt = Date.now() + 5 * 60000;
      this.lastRun = { at: new Date().toISOString(), results, error: error instanceof Error ? error.message : 'Todoist sync failed.' };
    } finally { this.running = false; }
    return results;
  }
}
