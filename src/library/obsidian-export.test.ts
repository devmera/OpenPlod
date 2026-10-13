import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsidianExporter, renderBlock, type NoteSource } from './obsidian-export';

let sqlite: Database, vault: string, exporter: ObsidianExporter;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'openplod-vault-'));
  mkdirSync(join(vault, '.obsidian'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE recordings (id TEXT PRIMARY KEY, original_filename TEXT, recorded_at TEXT, uploaded_at TEXT DEFAULT (datetime('now')), duration_seconds INTEGER,
      source_provider TEXT, recording_type TEXT NOT NULL DEFAULT 'meeting', revision INTEGER NOT NULL DEFAULT 1, retention_state TEXT NOT NULL DEFAULT 'active', status TEXT NOT NULL DEFAULT 'complete');
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE, full_text TEXT NOT NULL, segments TEXT, summary TEXT, extracted_tasks TEXT, analyzed_at TEXT, current_version_id TEXT);`);
  exporter = new ObsidianExporter(sqlite);
  exporter.saveSettings({ vaultPath: vault, folder: 'OpenPlod', auto: true });
  sqlite.query("INSERT INTO recordings (id, original_filename, recorded_at, duration_seconds, source_provider) VALUES ('r1', 'Budget-sync.m4a', '2026-10-13T13:26:00Z', 754, 'plaud')").run();
  sqlite.query(`INSERT INTO transcripts (id, recording_id, full_text, segments, summary, extracted_tasks, analyzed_at) VALUES ('t1', 'r1', 'Hej. Hi.', ?, ?, ?, '2026-10-13T13:30:00Z')`).run(
    JSON.stringify([{ start: 0, end: 2, text: 'Hej allihopa.', speaker: 'Joakim' }, { start: 2, end: 4, text: 'Vi börjar.', speaker: 'Joakim' }, { start: 4, end: 6, text: 'Sounds good.', speaker: 1 }]),
    JSON.stringify({ overview: 'Budget for next year.', keyPoints: ['Hire two developers'], topics: ['Budget'] }),
    JSON.stringify([{ title: 'Send board report', context: 'x' }, { title: 'send board report', context: 'y' }]));
});
afterEach(() => { sqlite.close(); rmSync(vault, { recursive: true, force: true }); });

const notePath = () => join(vault, 'OpenPlod', readdirSync(join(vault, 'OpenPlod'))[0]);
const changeTranscript = (summary: string) => {
  sqlite.query('UPDATE transcripts SET summary = ? WHERE id = ?').run(JSON.stringify({ overview: summary, keyPoints: [] }), 't1');
  sqlite.query('UPDATE recordings SET revision = revision + 1').run();
};

test('renders summary, deduplicated action items and the transcript by speaker turn', () => {
  const note = { id: 'r1', title: 'x', recordedAt: '2026-10-13T13:26:00Z', durationSeconds: 3, sourceProvider: 'plaud', recordingType: 'meeting', fullText: '',
    segments: [{ start: 0, text: 'Hej.', speaker: 'Joakim' }, { start: 1, text: 'Igen.', speaker: 'Joakim' }, { start: 65, text: 'Hi.', speaker: 0 }],
    summary: { overview: 'O' }, tasks: [{ title: 'A' }, { title: 'a' }] } satisfies NoteSource;
  const block = renderBlock(note);
  expect(block).toContain('- [ ] A\n\n');
  expect(block).toContain('**Joakim** · 0:00\nHej. Igen.\n\n**Speaker 1** · 1:05\nHi.');
});

test('creates one note with properties, then keeps the user\'s text and properties on update', async () => {
  expect((await exporter.run())[0]).toMatchObject({ action: 'created', path: 'OpenPlod/2026-10-13 Budget sync.md' });
  const created = readFileSync(notePath(), 'utf8');
  expect(created).toStartWith('---\nopenplod_id: "r1"\n');
  expect(created).toContain('duration: "12:34"');
  expect(created).toContain('speakers: ["Joakim", "Speaker 2"]');
  expect(created).toContain('tags: ["openplod", "meeting"]');
  expect(await exporter.run()).toEqual([]); // nothing changed

  writeFileSync(notePath(), created.replace('tags: ["openplod", "meeting"]', 'tags: ["openplod", "meeting"]\nproject: "Atlas"').replace('# Budget sync\n', '# Budget sync\n\nMy own notes.\n') + '\nFollow-up later.\n');
  changeTranscript('Revised budget.');
  expect((await exporter.run())[0].action).toBe('updated');
  const updated = readFileSync(notePath(), 'utf8');
  expect(updated).toContain('Revised budget.');
  expect(updated).toContain('My own notes.');
  expect(updated).toContain('Follow-up later.');
  expect(updated).toContain('project: "Atlas"');
  expect(updated.match(/openplod_id/g)).toHaveLength(1);
});

test('an edit inside the managed block is a conflict until replaced', async () => {
  await exporter.run();
  const edited = readFileSync(notePath(), 'utf8').replace('Budget for next year.', 'My better summary.');
  writeFileSync(notePath(), edited);
  changeTranscript('Revised budget.');
  expect((await exporter.run())[0]).toMatchObject({ action: 'conflict' });
  expect(readFileSync(notePath(), 'utf8')).toBe(edited);
  expect(exporter.conflicts()).toHaveLength(1);
  expect(await exporter.run()).toEqual([]); // not retried until the recording changes again
  expect((await exporter.exportRecording('r1', { replace: true })).action).toBe('updated');
  expect(readFileSync(notePath(), 'utf8')).toContain('Revised budget.');
  expect(exporter.conflicts()).toHaveLength(0);
});

test('a renamed or moved note is found again; a deleted one is not recreated automatically', async () => {
  await exporter.run();
  mkdirSync(join(vault, 'Meetings'));
  renameSync(notePath(), join(vault, 'Meetings', 'Budget.md'));
  changeTranscript('Moved.');
  expect((await exporter.run())[0]).toMatchObject({ action: 'updated', path: 'Meetings/Budget.md' });
  unlinkSync(join(vault, 'Meetings', 'Budget.md'));
  changeTranscript('Deleted.');
  expect((await exporter.run())[0].action).toBe('deleted');
  expect(existsSync(join(vault, 'Meetings', 'Budget.md'))).toBe(false);
  expect((await exporter.exportRecording('r1', { replace: true })).action).toBe('created');
});

test('waits for processing to finish and skips Trash; automatic runs need the setting', async () => {
  sqlite.query("UPDATE recordings SET status = 'summarizing'").run();
  expect(await exporter.run()).toEqual([]);
  sqlite.query("UPDATE recordings SET status = 'complete', retention_state = 'trash'").run();
  expect(await exporter.run()).toEqual([]);
  sqlite.query("UPDATE recordings SET retention_state = 'active'").run();
  exporter.saveSettings({ vaultPath: vault, folder: 'OpenPlod', auto: false });
  expect(await exporter.run({ onlyIfAuto: true })).toEqual([]);
  expect(() => exporter.saveSettings({ vaultPath: join(vault, 'missing'), folder: 'x', auto: false })).toThrow('existing vault');
  expect(() => exporter.saveSettings({ vaultPath: vault, folder: '../outside', auto: false })).toThrow('inside the vault');
});
