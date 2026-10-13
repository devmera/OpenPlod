import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingRecorder, START_AFTER_MS, STOP_AFTER_MS, meetingTitle, type BridgeEvent, type MeetingApp } from './meeting-recorder';

const zoom = { id: 'zoom', name: 'Zoom' }, browser = { id: 'browser', name: 'Browser call' };

function setup(options: { autoRecord?: boolean; available?: boolean } = {}) {
  const database = new Database(':memory:');
  database.exec("CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const staging = mkdtempSync(join(tmpdir(), 'openplod-meetings-'));
  let clock = 1_000_000;
  const commands: string[] = [];
  const finalized: { path: string; app: MeetingApp | null; startedAt: Date; durationSeconds: number; marks: { seconds: number; note: string }[] }[] = [];
  let emit: (event: BridgeEvent) => void = () => {};
  const recorder = new MeetingRecorder({
    database,
    stagingDirectory: () => staging,
    now: () => clock,
    spawnBridge: onEvent => {
      if (options.available === false) return null;
      emit = onEvent;
      return { start: (path, label, options) => commands.push(`start ${label}${options.bar ? '' : ' (no bar)'} ${path}`), stop: () => commands.push('stop'), close: () => commands.push('close') };
    },
    finalize: async params => {
      finalized.push(params);
      rmSync(params.path, { force: true }); // as the real import does
      return { recordingId: `rec-${finalized.length}`, title: 'Zoom meeting', app: params.app?.name ?? null, durationSeconds: params.durationSeconds, importedAt: new Date(clock).toISOString() };
    },
  });
  recorder.start();
  if (options.autoRecord) recorder.configure({ autoRecord: true });
  const advance = (ms: number) => { clock += ms; recorder.tick(); };
  const lastStartPath = () => commands.filter(command => command.startsWith('start')).at(-1)!.split(' ').at(-1)!;
  return { recorder, commands, finalized, staging, advance, emit: (event: BridgeEvent) => emit(event), lastStartPath, database };
}

test('nothing is recorded until automatic recording is turned on', () => {
  const { recorder, commands, advance, emit } = setup();
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS * 10);
  expect(commands).toEqual([]);
  expect(recorder.status().autoRecord).toBe(false);
});

test('starts after the app holds the mic for a few seconds and stops after it lets go', async () => {
  const { recorder, commands, finalized, advance, emit, lastStartPath } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS - 1);
  expect(commands).toEqual([]);
  advance(1);
  expect(commands[0]).toStartWith('start Zoom ');
  const path = lastStartPath();
  expect(recorder.status().recording?.starting).toBe(true);
  emit({ event: 'started', path });
  expect(recorder.status().recording).toMatchObject({ app: zoom, starting: false });

  // A brief release (switching audio devices) does not end the recording.
  emit({ event: 'apps', apps: [] });
  advance(STOP_AFTER_MS - 1);
  emit({ event: 'apps', apps: [zoom] });
  advance(STOP_AFTER_MS);
  expect(commands).not.toContain('stop');

  emit({ event: 'apps', apps: [] });
  advance(STOP_AFTER_MS);
  expect(commands).toContain('stop');
  emit({ event: 'stopped', path, durationSeconds: 1800, reason: 'command' });
  await recorder.settled();
  expect(finalized).toEqual([expect.objectContaining({ path, app: zoom, durationSeconds: 1800 })]);
  expect(recorder.status().recent[0]).toMatchObject({ recordingId: 'rec-1', app: 'Zoom' });
});

test('a dedicated app wins over a browser and disabled apps are ignored', () => {
  const { commands, advance, emit, recorder } = setup({ autoRecord: true });
  recorder.configure({ enabledApps: ['browser', 'zoom', 'not-an-app'] });
  expect(recorder.status().enabledApps).toEqual(['browser', 'zoom']);
  emit({ event: 'apps', apps: [browser, zoom] });
  advance(START_AFTER_MS);
  expect(commands[0]).toStartWith('start Zoom ');

  const other = setup({ autoRecord: true });
  other.recorder.configure({ enabledApps: ['zoom'] });
  other.emit({ event: 'apps', apps: [browser] });
  other.advance(START_AFTER_MS * 5);
  expect(other.commands).toEqual([]);
});

test('stopping mid-call suppresses that call until the app releases the mic', () => {
  const { recorder, commands, advance, emit, lastStartPath } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  const path = lastStartPath();
  emit({ event: 'started', path });
  recorder.stop();
  emit({ event: 'stopped', path, durationSeconds: 60, reason: 'command' });
  advance(START_AFTER_MS * 10);
  expect(commands.filter(command => command.startsWith('start'))).toHaveLength(1);

  emit({ event: 'apps', apps: [] });
  advance(1000);
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  expect(commands.filter(command => command.startsWith('start'))).toHaveLength(2);
});

test('the notification stop action also suppresses the current call', () => {
  const { commands, advance, emit, lastStartPath } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  const path = lastStartPath();
  emit({ event: 'started', path });
  emit({ event: 'stopped', path, durationSeconds: 60, reason: 'notification' });
  advance(START_AFTER_MS * 10);
  expect(commands.filter(command => command.startsWith('start'))).toHaveLength(1);
});

test('a failed start is reported and not retried every tick', () => {
  const { recorder, commands, advance, emit } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  emit({ event: 'error', message: 'OpenPlod needs microphone access.' });
  advance(START_AFTER_MS * 10);
  expect(commands.filter(command => command.startsWith('start'))).toHaveLength(1);
  expect(recorder.status()).toMatchObject({ recording: null, error: 'OpenPlod needs microphone access.' });
});

test('manual recordings ignore detection and very short captures are discarded', async () => {
  const { recorder, commands, finalized, advance, emit, lastStartPath } = setup();
  recorder.startManually();
  expect(commands[0]).toStartWith('start meeting ');
  const path = lastStartPath();
  writeFileSync(path, 'x');
  emit({ event: 'started', path });
  advance(STOP_AFTER_MS * 3);
  expect(commands).not.toContain('stop');
  expect(() => recorder.startManually()).toThrow('already being recorded');
  recorder.stop();
  emit({ event: 'stopped', path, durationSeconds: 1.5, reason: 'command' });
  await recorder.settled();
  expect(finalized).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test('the in-app recorder holds automatic recording off', () => {
  const { recorder, commands, advance, emit } = setup({ autoRecord: true });
  recorder.hold(true);
  emit({ event: 'apps', apps: [browser] });
  advance(START_AFTER_MS * 5);
  expect(commands).toEqual([]);
  recorder.hold(false);
  advance(1);
  expect(commands[0]).toStartWith('start Browser call ');
});

test('a helper crash imports the partial recording and a restart recovers staging files', async () => {
  const { recorder, finalized, advance, emit, lastStartPath, staging } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  const path = lastStartPath();
  writeFileSync(path, Buffer.alloc(4096 + 48_000 * 4 * 60)); // one minute of 16-bit stereo PCM
  emit({ event: 'started', path });
  emit({ event: 'exit' });
  await recorder.settled();
  expect(finalized[0]).toMatchObject({ path, app: zoom });
  expect(finalized[0].durationSeconds).toBeCloseTo(60, 0);
  expect(recorder.status().available).toBe(false);

  const leftover = join(staging, '1700000000000-teams.caf');
  writeFileSync(leftover, Buffer.alloc(4096 + 48_000 * 4 * 10));
  await recorder.recoverStaging();
  expect(finalized[1]).toMatchObject({ path: leftover, app: { id: 'teams', name: 'Microsoft Teams' } });
  expect(finalized[1].startedAt.toISOString()).toBe(new Date(1700000000000).toISOString());
});

test('turning on automatic recording without the helper explains why', () => {
  const { recorder } = setup({ available: false });
  expect(() => recorder.configure({ autoRecord: true })).toThrow('macOS 14.2');
  expect(recorder.status()).toMatchObject({ available: false, autoRecord: false });
});

test('titles are readable and filename-safe', () => {
  expect(meetingTitle(zoom, new Date(2026, 9, 13, 14, 2))).toBe('Zoom meeting 13 Oct 2026 14.02');
  expect(meetingTitle(null, new Date(2026, 0, 2, 9, 5))).toBe('Meeting 2 Jan 2026 09.05');
});

test('marks from the floating bar travel with the capture into the import', async () => {
  const { recorder, finalized, advance, emit, lastStartPath } = setup({ autoRecord: true });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  const path = lastStartPath();
  emit({ event: 'started', path });
  emit({ event: 'mark', path, seconds: 42, note: 'Action item' });
  emit({ event: 'mark', path: '/somewhere/else.caf', seconds: 1, note: 'ignored' });
  emit({ event: 'mark', path, seconds: 90, note: '' });
  expect(existsSync(`${path}.marks.json`)).toBe(true);
  emit({ event: 'stopped', path, durationSeconds: 120, reason: 'bar' });
  await recorder.settled();
  expect(finalized[0].marks).toEqual([{ seconds: 42, note: 'Action item' }, { seconds: 90, note: '' }]);
  // Stopping from the bar mid-call skips the rest of that call, like the notification.
  advance(START_AFTER_MS * 10);
  expect(recorder.status().recording).toBeNull();
});

test('the floating bar can be turned off', () => {
  const { recorder, commands, advance, emit } = setup({ autoRecord: true });
  expect(recorder.status().floatingBar).toBe(true);
  recorder.configure({ floatingBar: false });
  emit({ event: 'apps', apps: [zoom] });
  advance(START_AFTER_MS);
  expect(commands[0]).toStartWith('start Zoom (no bar) ');
});
