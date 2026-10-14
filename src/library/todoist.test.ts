import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TodoistPublisher, evidenceOverlaps, quoteStart, taskKey, type Command, type TodoistApi } from './todoist';

let sqlite: Database, sent: Command[][], publisher: TodoistPublisher, reject: string | null;
const fake: TodoistApi = {
  async sync(commands) {
    sent.push(commands);
    return { status: Object.fromEntries(commands.map(command => [command.uuid, reject && command.args.content === reject ? { error: 'Invalid' } : 'ok'])), tempIds: Object.fromEntries(commands.map((command, index) => [command.temp_id ?? '', `t${sent.length}-${index}`])) };
  },
  async read() { return { projects: [{ id: 'inbox', name: 'Inbox', inbox: true }, { id: 'p1', name: 'Work', inbox: false }], labels: sent.length ? ['openplod'] : [] }; },
};
const items = () => sent.flat().filter(command => command.type === 'item_add');
const summarize = (tasks: object[], at = new Date().toISOString()) =>
  sqlite.query('UPDATE transcripts SET extracted_tasks = ?, analyzed_at = ? WHERE recording_id = ?').run(JSON.stringify(tasks), at, 'r1');

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE recordings (id TEXT PRIMARY KEY, original_filename TEXT, recorded_at TEXT, uploaded_at TEXT, retention_state TEXT NOT NULL DEFAULT 'active', status TEXT NOT NULL DEFAULT 'complete');
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE, extracted_tasks TEXT, analyzed_at TEXT, segments TEXT);
    INSERT INTO recordings (id, original_filename, recorded_at) VALUES ('r1', 'Budget-sync.m4a', '2026-10-13T13:26:00Z');
    INSERT INTO transcripts (id, recording_id) VALUES ('t1', 'r1');`);
  sent = []; reject = null;
  publisher = new TodoistPublisher(sqlite, () => fake);
});

const mine = { title: 'Send board report', mine: true, context: 'I will send the board report to Anna on Friday.', dueDate: '2026-10-16', dueEvidence: 'on Friday' };
const theirs = { title: 'Book room', mine: false, assignee: 'Bo', context: 'Bo books the room.' };

test('sends only my tasks automatically, once, with evidence and deadline', async () => {
  await publisher.saveSettings({ token: 'secret', projectId: 'p1', auto: true, principal: 'Joakim' });
  summarize([mine, theirs]);
  expect((await publisher.run()).map(result => result.action)).toEqual(['created']);
  const [add] = items();
  expect(add.args).toMatchObject({ content: 'Send board report', project_id: 'p1', labels: ['openplod'], due: { date: '2026-10-16' } });
  expect(add.args.description).toContain('> I will send the board report');
  expect(add.args.description).toContain('Budget sync');
  expect(sent[0][0]).toMatchObject({ type: 'label_add', args: { name: 'openplod' } });
  // A second cycle and a new summary that quotes the same promise differently add nothing.
  expect(await publisher.run()).toEqual([]);
  summarize([{ ...mine, title: 'Mail Anna the board report', context: 'I will send the board report to Anna on Friday' }]);
  expect(await publisher.run()).toEqual([]);
  expect(items()).toHaveLength(1);
  expect(publisher.tasks('r1')[0]).toMatchObject({ todoistId: 't2-0', sentAt: expect.any(String) });
});

test('someone else\'s task is sent only by hand; failures are retried rather than recorded', async () => {
  await publisher.saveSettings({ token: 'secret', projectId: '', auto: false, principal: '' });
  summarize([mine, theirs]);
  expect(await publisher.run()).toEqual([]);
  reject = 'Book room';
  const key = taskKey('r1', theirs.context);
  expect(await publisher.send('r1', [key])).toEqual([{ key, title: 'Book room', action: 'failed', reason: 'Invalid' }]);
  reject = null;
  expect((await publisher.send('r1', [key]))[0].action).toBe('created');
  expect(items().at(-1)!.args.project_id).toBeUndefined();
  // The retry reuses the command uuid, so Todoist cannot run it twice either.
  expect(items()[0].uuid).toBe(items()[1].uuid);
});

test('turning automatic sending on does not send the back catalogue', async () => {
  summarize([mine], '2026-01-01T00:00:00.000Z');
  await publisher.saveSettings({ token: 'secret', projectId: '', auto: true, principal: '' });
  expect(publisher.pending()).toEqual([]);
});

test('evidence overlap needs a substantial shared passage', () => {
  expect(evidenceOverlaps('I will send the board report to Anna', 'Okay. I will send the board report to Anna on Friday.')).toBe(true);
  expect(evidenceOverlaps('send it', 'I will send it tomorrow')).toBe(false);
});

test('a task knows where its quote was said, and every meeting\'s tasks can be listed together', () => {
  const segments = [{ start: 0, text: 'Welcome everyone.' }, { start: 4, text: 'Okay so the plan.' }, { start: 9, text: 'I will send the board report' }, { start: 12, text: 'to Anna on Friday.' }, { start: 15, text: 'Great.' }];
  expect(quoteStart(mine.context, segments)).toBe(9);
  expect(quoteStart('Something nobody said at all here', segments)).toBeNull();
  sqlite.query('UPDATE transcripts SET segments = ? WHERE id = ?').run(JSON.stringify(segments), 't1');
  summarize([mine, theirs]);
  expect(publisher.tasks('r1')[0].start).toBe(9);
  expect(publisher.allTasks()).toEqual([{ recordingId: 'r1', title: 'Budget sync', recordedAt: '2026-10-13T13:26:00Z', tasks: publisher.tasks('r1') }]);
  sqlite.query("UPDATE recordings SET retention_state = 'trash'").run();
  expect(publisher.allTasks()).toEqual([]);
});
