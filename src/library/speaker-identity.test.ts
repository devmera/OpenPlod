import { beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpeakerIdentity, matchSpeakers } from './speaker-identity';

let sqlite: Database;
beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE recordings (id TEXT PRIMARY KEY, retention_state TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE transcripts (id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE, full_text TEXT NOT NULL, segments TEXT);
    CREATE TABLE speaker_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', sample_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE speaker_mappings (id TEXT PRIMARY KEY, transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE, speaker_id INTEGER NOT NULL,
      profile_id TEXT REFERENCES speaker_profiles(id) ON DELETE SET NULL, confidence REAL, manually_assigned INTEGER NOT NULL DEFAULT 0, embedding TEXT, label TEXT);`);
});
// Stands in for updateTranscript, which versions the edit in the real database.
const identity = () => new SpeakerIdentity(sqlite, ({ recordingId, fullText, segments }) => {
  sqlite.query('UPDATE transcripts SET full_text = ?, segments = ? WHERE recording_id = ?').run(fullText, JSON.stringify(segments), recordingId);
});

// Unit voiceprints along separate axes, with a little noise so the same person never matches exactly.
const voice = (axis: number, noise = 0) => Array.from({ length: 8 }, (_, index) => (index === axis ? 1 : 0) + (index === 7 ? noise : 0));
const anna = voice(0), bo = voice(1), me = voice(2);

function transcribe(id: string, segments: { speaker: number; text: string; words?: unknown[] }[], embeddings: Record<number, number[]>, selfSpeaker?: number): (number | string)[] {
  const timed = segments.map((segment, index) => ({ start: index, end: index + 1, confidence: null, ...segment }));
  const identified = identity().identify(timed, embeddings, selfSpeaker);
  sqlite.query('INSERT INTO recordings (id) VALUES (?)').run(id);
  sqlite.query('INSERT INTO transcripts (id, recording_id, full_text, segments) VALUES (?, ?, ?, ?)').run(crypto.randomUUID(), id, '', JSON.stringify(identified.segments));
  identity().store(id, identified.rows);
  return identified.segments.map(segment => segment.speaker);
}
const current = (id: string) => JSON.parse((sqlite.query('SELECT segments FROM transcripts WHERE recording_id = ?').get(id) as { segments: string }).segments) as { speaker: unknown; words?: unknown }[];

test('matches only clear winners, one person per speaker', () => {
  const references = [{ profileId: 'a', name: 'Anna', centroid: anna }, { profileId: 'b', name: 'Bo', centroid: bo }];
  const matches = matchSpeakers({ 0: voice(0, 0.3), 1: voice(0, 0.5), 2: voice(3) }, references);
  expect([...matches]).toEqual([[0, { profileId: 'a', name: 'Anna', confidence: expect.any(Number) }]]);
  // Equally close to two people: no name rather than a guess.
  expect(matchSpeakers({ 0: [1, 1, 0, 0, 0, 0, 0, 0] }, references, 0.5).size).toBe(0);
});

test('a rename in one recording names the same voice in the next', () => {
  expect(transcribe('r1', [{ speaker: 0, text: 'Hej' }, { speaker: 1, text: 'Hi' }], { 0: anna, 1: bo })).toEqual([0, 1]);
  identity().learn('r1', [{ op: 'rename-speaker', from: 0, to: 'Anna' }]);
  expect(transcribe('r2', [{ speaker: 0, text: 'Hello' }, { speaker: 1, text: 'Tja' }], { 0: bo, 1: voice(0, 0.2) })).toEqual([0, 'Anna']);
  expect(identity().people()).toEqual([{ id: expect.any(String), name: 'Anna', category: 'other', samples: 1 }]);
});

test('automatic matches are not used as references', () => {
  transcribe('r1', [{ speaker: 0, text: 'a' }], { 0: anna });
  identity().learn('r1', [{ op: 'rename-speaker', from: 0, to: 'Anna' }]);
  transcribe('r2', [{ speaker: 0, text: 'b' }], { 0: voice(0, 0.2) });
  expect(identity().people()[0].samples).toBe(1);
});

test('undoing a rename forgets the voice', () => {
  transcribe('r1', [{ speaker: 0, text: 'a' }], { 0: anna });
  const speakers = identity();
  speakers.learn('r1', [{ op: 'rename-speaker', from: 0, to: 'Anna' }]);
  speakers.learn('r1', [{ op: 'rename-speaker', from: 'Anna', to: 0 }]);
  expect(speakers.people()).toEqual([]);
});

test('the microphone channel takes your name and teaches your voice', () => {
  identity().setSelfName('Joakim');
  expect(transcribe('meeting', [{ speaker: 0, text: 'Me' }, { speaker: 1, text: 'Them' }], { 0: me, 1: bo }, 0)).toEqual(['Joakim', 1]);
  // A room recording without channels now recognises the same voice.
  expect(transcribe('plaud', [{ speaker: 0, text: 'x' }, { speaker: 1, text: 'y' }], { 0: bo, 1: voice(2, 0.2) })).toEqual([0, 'Joakim']);
});

test('re-apply names past recordings and keeps word timings', () => {
  const words = [{ start: 0, end: 1, text: 'Hej' }];
  transcribe('old', [{ speaker: 0, text: 'Hej', words }, { speaker: 1, text: 'Hi' }], { 0: voice(0, 0.2), 1: bo });
  transcribe('new', [{ speaker: 0, text: 'Tja' }], { 0: anna });
  const speakers = identity();
  speakers.learn('new', [{ op: 'rename-speaker', from: 0, to: 'Anna' }]);
  expect(speakers.reapply()).toEqual({ recordings: 1, renamed: 1 });
  expect(current('old')).toMatchObject([{ speaker: 'Anna', words }, { speaker: 1 }]);
  // Renaming a person later carries through on the next re-apply.
  speakers.learn('new', [{ op: 'rename-speaker', from: 'Anna', to: 'Anna S' }]);
  expect(speakers.reapply()).toEqual({ recordings: 1, renamed: 1 });
  expect(current('old')[0].speaker).toBe('Anna S');
  expect(speakers.people().map(person => person.name)).toEqual(['Anna S']);
});
