/**
 * Managed one-way export of recordings into an Obsidian vault (roadmap KB-02).
 *
 * Each recording becomes one Markdown note. OpenPlod owns only the block
 * between its start/end markers and a few frontmatter keys; anything the user
 * writes around the block, and any other properties, are kept on every update.
 * A manifest records the hash of the block as last written, so an edit inside
 * the block is detected and never silently overwritten: the note is reported
 * as a conflict until the user chooses to replace it. Notes are found again by
 * `openplod_id` after being renamed or moved within the vault; a note the user
 * deleted is not recreated automatically.
 */
import type { Database } from 'bun:sqlite';
import { presentSummary } from './plaud-summary';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

export const START = '<!-- openplod:start · Managed by OpenPlod. Write your own notes above or below this block; editing inside it stops OpenPlod updating this note. -->';
export const END = '<!-- openplod:end -->';
const OWNED_KEYS = ['openplod_id', 'recorded', 'duration', 'source', 'speakers'];

export interface ObsidianSettings { vaultPath: string; folder: string; auto: boolean }
export type ExportAction = 'created' | 'updated' | 'unchanged' | 'conflict' | 'deleted' | 'skipped';
export interface ExportResult { recordingId: string; action: ExportAction; path?: string; reason?: string }

interface Segment { start?: number; end?: number; text: string; speaker?: number | string | null }
export interface NoteSource {
  id: string; title: string; recordedAt: string; durationSeconds: number | null; sourceProvider: string | null; recordingType: string;
  segments: Segment[]; fullText: string;
  summary: { overview?: string; keyPoints?: string[]; participants?: string[]; topics?: string[] } | null;
  tasks: { title: string; assignee?: string; dueDate?: string }[];
}

const expandHome = (path: string) => path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
const hash = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const quote = (value: string) => JSON.stringify(value);

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
const speakerName = (speaker: Segment['speaker']) => typeof speaker === 'string' ? speaker : typeof speaker === 'number' ? `Speaker ${speaker + 1}` : null;
const localDate = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');
const localDateTime = (iso: string) => new Date(iso).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The managed block: summary, key points, action items, then the transcript grouped by speaker turn. */
export function renderBlock(note: NoteSource): string {
  const lines = [START, '## Summary', '', note.summary?.overview?.trim() || '_No summary yet._', ''];
  if (note.summary?.keyPoints?.length) lines.push('### Key points', '', ...note.summary.keyPoints.map(point => `- ${point}`), '');
  const seen = new Set<string>();
  const tasks = note.tasks.filter(task => !seen.has(task.title.toLowerCase()) && seen.add(task.title.toLowerCase()));
  if (tasks.length) lines.push('### Action items', '', ...tasks.map(task => `- [ ] ${task.title}${task.assignee ? ` (${task.assignee})` : ''}${task.dueDate ? ` 📅 ${task.dueDate}` : ''}`), '');
  if (note.summary?.topics?.length) lines.push(`**Topics:** ${note.summary.topics.join(', ')}`, '');
  lines.push('## Transcript', '');
  const turns: { speaker: string | null; start?: number; text: string[] }[] = [];
  for (const segment of note.segments) {
    const speaker = speakerName(segment.speaker), last = turns.at(-1);
    if (last && last.speaker === speaker) last.text.push(segment.text.trim());
    else turns.push({ speaker, start: segment.start, text: [segment.text.trim()] });
  }
  if (!turns.length && note.fullText.trim()) lines.push(note.fullText.trim(), '');
  for (const turn of turns) {
    const time = Number.isFinite(turn.start) ? clock(turn.start!) : null;
    const heading = [turn.speaker && `**${turn.speaker}**`, time].filter(Boolean).join(' · ');
    if (heading) lines.push(heading);
    lines.push(turn.text.filter(Boolean).join(' '), '');
  }
  lines.push(END);
  return lines.join('\n');
}

/** Properties OpenPlod keeps current; `tags` are only set when the note is created and are the user's after that. */
export function ownedProperties(note: NoteSource): string[] {
  const speakers = [...new Set(note.segments.map(segment => speakerName(segment.speaker)).filter((name): name is string => Boolean(name)))];
  return [
    `openplod_id: ${quote(note.id)}`,
    `recorded: ${quote(localDateTime(note.recordedAt))}`,
    ...(note.durationSeconds ? [`duration: ${quote(clock(note.durationSeconds))}`] : []),
    `source: ${quote(note.sourceProvider ?? 'upload')}`,
    `speakers: [${speakers.map(quote).join(', ')}]`,
  ];
}

/** Replace OpenPlod's properties in existing frontmatter, keeping every other property and its position. */
export function mergeFrontmatter(frontmatter: string | null, owned: string[], tags: string[]): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of (frontmatter ?? '').split('\n')) {
    if (!line && !kept.length) continue;
    const key = /^([A-Za-z0-9_-]+):/.exec(line)?.[1];
    if (key) skipping = OWNED_KEYS.includes(key);
    else if (!/^\s+\S|^\s*-\s/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  const body = [...owned, ...kept.filter(line => line.trim())];
  if (frontmatter === null) body.push(`tags: [${tags.map(quote).join(', ')}]`);
  return `---\n${body.join('\n')}\n---`;
}

/** Split a note into frontmatter, text before the block, the block, and text after it. */
export function parseNote(content: string) {
  const text = content.replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const rest = fm ? text.slice(fm[0].length) : text;
  const start = rest.indexOf('<!-- openplod:start'), end = rest.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { frontmatter: fm ? fm[1] : null, before: rest, block: null, after: '' };
  return { frontmatter: fm ? fm[1] : null, before: rest.slice(0, start), block: rest.slice(start, end + END.length), after: rest.slice(end + END.length) };
}

export function noteFileName(note: NoteSource) {
  const title = note.title.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Recording';
  return `${localDate(note.recordedAt)} ${title}.md`;
}

export class ObsidianExporter {
  private running = false;
  lastRun: { at: string; results: ExportResult[] } | null = null;

  constructor(private sqlite: Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS obsidian_exports (recording_id TEXT PRIMARY KEY, path TEXT NOT NULL, block_hash TEXT NOT NULL,
      source_key TEXT NOT NULL, exported_at TEXT NOT NULL, conflict TEXT)`);
  }

  settings(): ObsidianSettings {
    const rows = this.sqlite.query("SELECT key, value FROM user_settings WHERE key IN ('obsidianVaultPath', 'obsidianFolder', 'obsidianAutoExport')").all() as { key: string; value: string }[];
    const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
    return { vaultPath: values.obsidianVaultPath ?? '', folder: values.obsidianFolder ?? 'OpenPlod', auto: values.obsidianAutoExport === 'true' };
  }

  saveSettings(next: ObsidianSettings): ObsidianSettings {
    const vaultPath = next.vaultPath.trim(), folder = next.folder.trim().replace(/^\/+|\/+$/g, '');
    if (vaultPath) {
      const resolved = expandHome(vaultPath);
      if (!isAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error('Choose an existing vault folder.');
    }
    if (isAbsolute(folder) || normalize(folder).split(sep).includes('..')) throw new Error('The note folder must be inside the vault.');
    if (next.auto && !vaultPath) throw new Error('Choose a vault before turning on automatic export.');
    const upsert = this.sqlite.query("INSERT INTO user_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
    upsert.run('obsidianVaultPath', vaultPath); upsert.run('obsidianFolder', folder); upsert.run('obsidianAutoExport', String(next.auto));
    return this.settings();
  }

  /** Vault folders found in the usual places, for the settings picker. */
  async discoverVaults(): Promise<string[]> {
    const roots = [join(homedir(), 'Documents'), join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents'), homedir()];
    const found = new Set<string>();
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isDirectory() && existsSync(join(root, entry.name, '.obsidian'))) found.add(join(root, entry.name));
    }
    return [...found].sort();
  }

  conflicts() {
    return this.sqlite.query(`SELECT e.recording_id AS recordingId, e.path, e.conflict AS reason, r.original_filename AS filename
      FROM obsidian_exports e JOIN recordings r ON r.id = e.recording_id WHERE e.conflict IS NOT NULL ORDER BY e.exported_at DESC`).all() as
      { recordingId: string; path: string; reason: string; filename: string | null }[];
  }

  private source(recordingId: string): { note: NoteSource; key: string } | null {
    const row = this.sqlite.query(`SELECT r.id, r.original_filename AS filename, r.recorded_at AS recordedAt, r.uploaded_at AS uploadedAt, r.duration_seconds AS duration,
        r.source_provider AS sourceProvider, r.recording_type AS recordingType, r.revision, r.retention_state AS retention,
        t.full_text AS fullText, t.segments, t.summary, t.extracted_tasks AS tasks, t.analyzed_at AS analyzedAt, t.current_version_id AS versionId
      FROM recordings r JOIN transcripts t ON t.recording_id = r.id WHERE r.id = ?`).get(recordingId) as Record<string, string | number | null> | null;
    if (!row || row.retention !== 'active') return null;
    const json = <T>(value: unknown, fallback: T): T => { try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } };
    return {
      key: `${row.revision}:${row.analyzedAt ?? ''}:${row.versionId ?? ''}`,
      note: {
        id: String(row.id),
        title: String(row.filename ?? '').replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'Recording',
        recordedAt: String(row.recordedAt ?? row.uploadedAt), durationSeconds: row.duration === null ? null : Number(row.duration),
        sourceProvider: row.sourceProvider === null ? null : String(row.sourceProvider), recordingType: String(row.recordingType),
        segments: json<Segment[]>(row.segments, []), fullText: String(row.fullText ?? ''),
        summary: presentSummary(this.sqlite, String(row.id), row.recordedAt === null ? null : String(row.recordedAt), json(row.summary, null)), tasks: json(row.tasks, []),
      },
    };
  }

  /** Find a note by its `openplod_id` anywhere in the vault, e.g. after the user renamed or moved it. */
  private async locate(vault: string, recordingId: string): Promise<string | null> {
    const needle = `openplod_id: ${quote(recordingId)}`;
    const walk = async (directory: string): Promise<string | null> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { const hit = await walk(path); if (hit) return hit; }
        else if (entry.name.endsWith('.md') && (await readFile(path, 'utf8').catch(() => '')).slice(0, 2000).includes(needle)) return path;
      }
      return null;
    };
    return walk(vault);
  }

  private async write(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.openplod-${process.pid}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  }

  /** Export one recording. `replace` overwrites a block edited in Obsidian, or recreates a deleted note. */
  async exportRecording(recordingId: string, options: { replace?: boolean } = {}): Promise<ExportResult> {
    const settings = this.settings();
    if (!settings.vaultPath) throw new Error('Choose an Obsidian vault in Settings first.');
    const vault = expandHome(settings.vaultPath);
    const source = this.source(recordingId);
    if (!source) return { recordingId, action: 'skipped', reason: 'No transcript yet.' };
    const manifest = this.sqlite.query('SELECT path, block_hash AS blockHash, source_key AS sourceKey FROM obsidian_exports WHERE recording_id = ?').get(recordingId) as
      { path: string; blockHash: string; sourceKey: string } | null;
    const block = renderBlock(source.note), owned = ownedProperties(source.note);
    const tags = ['openplod', ...(source.note.recordingType && source.note.recordingType !== 'other' ? [source.note.recordingType] : [])];

    let path = manifest && existsSync(join(vault, manifest.path)) ? join(vault, manifest.path) : null;
    if (!path && manifest) path = await this.locate(vault, recordingId);
    if (!path && manifest && !options.replace) return this.record(recordingId, manifest.path, manifest.blockHash, source.key, 'deleted', 'The note was deleted in Obsidian.');

    let content: string;
    let action: ExportAction;
    if (path) {
      const existing = parseNote(await readFile(path, 'utf8'));
      if (!existing.block && !options.replace) return this.record(recordingId, relative(vault, path), manifest?.blockHash ?? '', source.key, 'conflict', 'The OpenPlod markers were removed from the note.');
      if (existing.block && manifest && hash(existing.block) !== manifest.blockHash && !options.replace)
        return this.record(recordingId, relative(vault, path), manifest.blockHash, source.key, 'conflict', 'The OpenPlod part of the note was edited in Obsidian.');
      const frontmatter = mergeFrontmatter(existing.frontmatter, owned, tags);
      const body = existing.block ? `${existing.before}${block}${existing.after}` : `${existing.before.trimEnd()}\n\n${block}\n`;
      content = `${frontmatter}\n${body.startsWith('\n') ? body.slice(1) : body}`;
      action = existing.block === block && existing.frontmatter !== null && frontmatter === `---\n${existing.frontmatter}\n---` ? 'unchanged' : 'updated';
    } else {
      const folder = join(vault, settings.folder);
      let name = noteFileName(source.note);
      for (let n = 2; existsSync(join(folder, name)); n++) name = noteFileName(source.note).replace(/\.md$/, ` ${n}.md`);
      path = join(folder, name);
      content = `${mergeFrontmatter(null, owned, tags)}\n# ${source.note.title}\n\n${block}\n`;
      action = 'created';
    }
    if (action !== 'unchanged') await this.write(path, content);
    return this.record(recordingId, relative(vault, path), hash(block), source.key, action);
  }

  private record(recordingId: string, path: string, blockHash: string, sourceKey: string, action: ExportAction, reason?: string): ExportResult {
    const problem = action === 'conflict' || action === 'deleted' ? reason ?? action : null;
    this.sqlite.query(`INSERT INTO obsidian_exports(recording_id, path, block_hash, source_key, exported_at, conflict) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(recording_id) DO UPDATE SET path = excluded.path, block_hash = excluded.block_hash, source_key = excluded.source_key, exported_at = excluded.exported_at, conflict = excluded.conflict`)
      .run(recordingId, path, blockHash, sourceKey, new Date().toISOString(), problem);
    return { recordingId, action, path, ...(reason ? { reason } : {}) };
  }

  /** Recordings whose transcript or summary changed since their last export, finished processing, and not in Trash. */
  pending(): string[] {
    const rows = this.sqlite.query(`SELECT r.id, r.revision || ':' || coalesce(t.analyzed_at, '') || ':' || coalesce(t.current_version_id, '') AS key, e.source_key AS exported
      FROM recordings r JOIN transcripts t ON t.recording_id = r.id LEFT JOIN obsidian_exports e ON e.recording_id = r.id
      WHERE r.retention_state = 'active' AND r.status NOT IN ('pending', 'transcribing', 'summarizing')`).all() as { id: string; key: string; exported: string | null }[];
    return rows.filter(row => row.key !== row.exported).map(row => row.id);
  }

  /** Export everything pending (or every recording with `all`). Single-flight; failures are reported per recording. */
  async run(options: { all?: boolean; onlyIfAuto?: boolean } = {}): Promise<ExportResult[]> {
    const settings = this.settings();
    if (this.running || !settings.vaultPath || (options.onlyIfAuto && !settings.auto)) return [];
    this.running = true;
    try {
      const ids = options.all
        ? (this.sqlite.query("SELECT r.id FROM recordings r JOIN transcripts t ON t.recording_id = r.id WHERE r.retention_state = 'active'").all() as { id: string }[]).map(row => row.id)
        : this.pending();
      const results: ExportResult[] = [];
      for (const id of ids) {
        try { results.push(await this.exportRecording(id)); }
        catch (error) { results.push({ recordingId: id, action: 'skipped', reason: error instanceof Error ? error.message : 'Export failed.' }); }
      }
      if (results.length) this.lastRun = { at: new Date().toISOString(), results };
      return results;
    } finally { this.running = false; }
  }
}
