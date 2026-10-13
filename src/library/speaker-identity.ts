/**
 * Recognising the same people across recordings.
 *
 * Each diarized speaker of the current transcript has a `speaker_mappings` row
 * holding its voiceprint and the label it currently has in the transcript.
 * Renaming a speaker in the editor links that row to a person
 * (`speaker_profiles`) and marks it confirmed. Only confirmed voiceprints are
 * used as references, so an automatic match never reinforces itself.
 *
 * Matching is deliberately strict: an unnamed speaker costs one rename, a
 * wrongly named one is trusted. Thresholds were set on synthetic voices
 * (same voice 0.81-0.93, different voices up to 0.70) and should be revisited
 * with real recordings.
 */
import type { Database } from 'bun:sqlite';
import { parseSegments, segmentsToText, type TranscriptOperation } from './transcript-operations';
import { updateTranscript } from './transcript-history';

export const MATCH_THRESHOLD = 0.75;
export const MATCH_MARGIN = 0.1;

type Label = number | string;
const encode = (label: Label) => JSON.stringify(label);

export interface Person { profileId: string; name: string }
export interface Reference extends Person { centroid: number[] }
export interface Match extends Person { confidence: number }
export interface SpeakerRow { speaker: number; label: Label; profileId: string | null; confidence: number | null; confirmed: boolean; embedding: number[] | null }

function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length ? vector.map(value => value / length) : vector;
}
const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

/** Pure matching: each speaker gets at most one person and each person at most one speaker. */
export function matchSpeakers(embeddings: Record<number, number[]>, references: Reference[], threshold = MATCH_THRESHOLD, margin = MATCH_MARGIN): Map<number, Match> {
  const candidates: { speaker: number; match: Match }[] = [];
  for (const [speaker, embedding] of Object.entries(embeddings)) {
    const vector = normalize(embedding);
    const scores = references.map(reference => ({ reference, score: cosine(vector, reference.centroid) })).sort((a, b) => b.score - a.score);
    const [best, second] = scores;
    if (!best || best.score < threshold || best.score - (second?.score ?? -1) < margin) continue;
    candidates.push({ speaker: Number(speaker), match: { profileId: best.reference.profileId, name: best.reference.name, confidence: best.score } });
  }
  const result = new Map<number, Match>(), taken = new Set<string>();
  for (const { speaker, match } of candidates.sort((a, b) => b.match.confidence - a.match.confidence)) {
    if (taken.has(match.profileId)) continue;
    taken.add(match.profileId);
    result.set(speaker, match);
  }
  return result;
}

export class SpeakerIdentity {
  constructor(private sqlite: Database, private saveEdit: typeof updateTranscript = updateTranscript) {}

  /** Averaged confirmed voiceprint per active person. */
  references(exclude: string[] = []): Reference[] {
    const rows = this.sqlite.query(`SELECT p.id, p.name, m.embedding FROM speaker_mappings m JOIN speaker_profiles p ON p.id = m.profile_id
      WHERE m.manually_assigned = 1 AND m.embedding IS NOT NULL AND p.is_active = 1`).all() as { id: string; name: string; embedding: string }[];
    const people = new Map<string, Reference>();
    for (const row of rows) {
      if (exclude.includes(row.id)) continue;
      const vector = normalize(JSON.parse(row.embedding) as number[]);
      const person = people.get(row.id) ?? { profileId: row.id, name: row.name, centroid: vector.map(() => 0) };
      person.centroid = person.centroid.map((value, index) => value + vector[index]);
      people.set(row.id, person);
    }
    return [...people.values()].map(person => ({ ...person, centroid: normalize(person.centroid) }));
  }

  self(): Person | null {
    const row = this.sqlite.query("SELECT id, name FROM speaker_profiles WHERE category = 'self' LIMIT 1").get() as { id: string; name: string } | null;
    return row && { profileId: row.id, name: row.name };
  }

  setSelfName(name: string): Person {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Enter your name.');
    const current = this.self();
    if (current) {
      this.sqlite.query("UPDATE speaker_profiles SET name = ?, updated_at = datetime('now') WHERE id = ?").run(trimmed, current.profileId);
      return { ...current, name: trimmed };
    }
    // Claim an existing person of that name (e.g. learned from an earlier rename) rather than splitting their voice in two.
    const existing = this.profileByName(trimmed);
    if (existing) {
      this.sqlite.query("UPDATE speaker_profiles SET category = 'self', updated_at = datetime('now') WHERE id = ?").run(existing);
      return { profileId: existing, name: trimmed };
    }
    const profileId = crypto.randomUUID();
    this.sqlite.query("INSERT INTO speaker_profiles (id, name, category) VALUES (?, ?, 'self')").run(profileId, trimmed);
    return { profileId, name: trimmed };
  }

  people() {
    return this.sqlite.query(`SELECT id, name, category, sample_count AS samples FROM speaker_profiles ORDER BY category = 'self' DESC, name COLLATE NOCASE`).all() as
      { id: string; name: string; category: string; samples: number }[];
  }

  /** Forget a person's voice. Names already written into transcripts stay as text. */
  forget(profileId: string) {
    this.sqlite.transaction(() => {
      this.sqlite.query('UPDATE speaker_mappings SET profile_id = NULL, manually_assigned = 0, confidence = NULL WHERE profile_id = ?').run(profileId);
      this.sqlite.query('DELETE FROM speaker_profiles WHERE id = ?').run(profileId);
    })();
  }

  /**
   * Name the speakers of a freshly generated transcript. `selfSpeaker` is a
   * speaker known to be this computer's user (the microphone channel of a
   * meeting capture). Returns relabelled segments and the rows to store once
   * the transcript becomes current.
   */
  identify<T extends { speaker?: Label | null }>(segments: T[], embeddings: Record<number, number[]>, selfSpeaker?: number): { segments: T[]; rows: SpeakerRow[] } {
    const self = selfSpeaker === undefined ? null : this.self();
    const matches = matchSpeakers(Object.fromEntries(Object.entries(embeddings).filter(([speaker]) => Number(speaker) !== selfSpeaker)),
      this.references(self ? [self.profileId] : []));
    const speakers = [...new Set(segments.map(segment => segment.speaker).filter((speaker): speaker is number => typeof speaker === 'number'))];
    const rows = speakers.map((speaker): SpeakerRow => {
      const embedding = embeddings[speaker] ?? null;
      if (self && speaker === selfSpeaker) return { speaker, label: self.name, profileId: self.profileId, confidence: 1, confirmed: true, embedding };
      const match = matches.get(speaker);
      return { speaker, label: match?.name ?? speaker, profileId: match?.profileId ?? null, confidence: match?.confidence ?? null, confirmed: false, embedding };
    });
    const labels = new Map(rows.map(row => [row.speaker, row.label]));
    return { segments: segments.map(segment => typeof segment.speaker === 'number' && labels.has(segment.speaker) ? { ...segment, speaker: labels.get(segment.speaker)! } : segment), rows };
  }

  /** Replace the speaker rows of a recording's current transcript. */
  store(recordingId: string, rows: SpeakerRow[]) {
    const transcript = this.sqlite.query('SELECT id FROM transcripts WHERE recording_id = ?').get(recordingId) as { id: string } | null;
    if (!transcript) return;
    this.sqlite.transaction(() => {
      this.sqlite.query('DELETE FROM speaker_mappings WHERE transcript_id = ?').run(transcript.id);
      const insert = this.sqlite.query('INSERT INTO speaker_mappings (id, transcript_id, speaker_id, profile_id, confidence, manually_assigned, embedding, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(crypto.randomUUID(), transcript.id, row.speaker, row.profileId, row.confidence, row.confirmed ? 1 : 0, row.embedding && JSON.stringify(row.embedding), encode(row.label));
      this.refreshCounts();
    })();
  }

  /** Learn from the editor: renaming or merging onto a name confirms whose voice that is. */
  learn(recordingId: string, operations: TranscriptOperation[]) {
    const transcript = this.sqlite.query('SELECT id FROM transcripts WHERE recording_id = ?').get(recordingId) as { id: string } | null;
    if (!transcript) return;
    this.sqlite.transaction(() => {
      for (const operation of operations) {
        if (operation.op === 'rename-speaker') this.move(transcript.id, operation.from, operation.to);
        else if (operation.op === 'merge-speakers') for (const source of operation.sources) this.move(transcript.id, source, operation.target);
      }
      this.refreshCounts();
    })();
  }

  private move(transcriptId: string, from: Label, to: Label) {
    if (typeof to === 'string') {
      const profileId = this.profileByName(to.trim()) ?? this.createProfile(to.trim());
      this.sqlite.query('UPDATE speaker_mappings SET label = ?, profile_id = ?, manually_assigned = 1, confidence = NULL WHERE transcript_id = ? AND label = ?')
        .run(encode(to.trim()), profileId, transcriptId, encode(from));
    } else {
      this.sqlite.query('UPDATE speaker_mappings SET label = ?, profile_id = NULL, manually_assigned = 0, confidence = NULL WHERE transcript_id = ? AND label = ?')
        .run(encode(to), transcriptId, encode(from));
    }
  }

  private profileByName(name: string) {
    return (this.sqlite.query('SELECT id FROM speaker_profiles WHERE name = ? COLLATE NOCASE LIMIT 1').get(name) as { id: string } | null)?.id ?? null;
  }

  private createProfile(name: string) {
    const id = crypto.randomUUID();
    this.sqlite.query('INSERT INTO speaker_profiles (id, name) VALUES (?, ?)').run(id, name);
    return id;
  }

  /** Sample counts follow confirmed voiceprints; people left with nothing (e.g. after undo) are removed. */
  private refreshCounts() {
    this.sqlite.exec(`UPDATE speaker_profiles SET sample_count = (SELECT count(*) FROM speaker_mappings m
      WHERE m.profile_id = speaker_profiles.id AND m.manually_assigned = 1 AND m.embedding IS NOT NULL)`);
    this.sqlite.exec(`DELETE FROM speaker_profiles WHERE category != 'self'
      AND NOT EXISTS (SELECT 1 FROM speaker_mappings m WHERE m.profile_id = speaker_profiles.id)`);
  }

  /**
   * Bring past transcripts in line with what is known now: confirmed speakers
   * take their person's current name, unconfirmed ones are matched again.
   * Changes are saved as an edited version, so history keeps the previous text.
   */
  reapply(): { recordings: number; renamed: number } {
    const transcripts = this.sqlite.query(`SELECT DISTINCT t.id, t.recording_id AS recordingId, t.segments FROM speaker_mappings m
      JOIN transcripts t ON t.id = m.transcript_id JOIN recordings r ON r.id = t.recording_id WHERE r.retention_state = 'active'`).all() as { id: string; recordingId: string; segments: string | null }[];
    const references = this.references();
    let changedRecordings = 0, renamed = 0;
    for (const transcript of transcripts) {
      const rows = this.sqlite.query(`SELECT m.id, m.speaker_id AS speaker, m.label, m.manually_assigned AS confirmed, m.embedding, p.id AS profileId, p.name
        FROM speaker_mappings m LEFT JOIN speaker_profiles p ON p.id = m.profile_id WHERE m.transcript_id = ?`).all(transcript.id) as
        { id: string; speaker: number; label: string | null; confirmed: number; embedding: string | null; profileId: string | null; name: string | null }[];
      const confirmedPeople = rows.filter(row => row.confirmed && row.profileId).map(row => row.profileId!);
      const open = rows.filter(row => !row.confirmed && row.embedding);
      const matches = matchSpeakers(Object.fromEntries(open.map(row => [row.speaker, JSON.parse(row.embedding!) as number[]])),
        references.filter(reference => !confirmedPeople.includes(reference.profileId)));
      const updates: { id: string; label: Label; profileId: string | null; confidence: number | null }[] = [];
      const renames = new Map<string, Label>();
      for (const row of rows) {
        const current = row.label ?? encode(row.speaker);
        const match = row.confirmed ? null : matches.get(row.speaker);
        const name = row.confirmed && row.name ? row.name : match?.name;
        if (!name || current === encode(name)) continue;
        renames.set(current, name);
        updates.push({ id: row.id, label: name, profileId: row.confirmed ? row.profileId : match!.profileId, confidence: row.confirmed ? null : match!.confidence });
      }
      if (!renames.size || !transcript.segments) continue;
      const segments = (JSON.parse(transcript.segments) as Record<string, unknown>[]).map(segment => {
        const speaker = segment.speaker;
        const name = (typeof speaker === 'number' || typeof speaker === 'string') ? renames.get(encode(speaker)) : undefined;
        return name === undefined ? segment : { ...segment, speaker: name };
      });
      try {
        this.saveEdit({ recordingId: transcript.recordingId, fullText: segmentsToText(parseSegments(segments)), segments });
      } catch { continue; }
      const update = this.sqlite.query('UPDATE speaker_mappings SET label = ?, profile_id = ?, confidence = ? WHERE id = ?');
      for (const row of updates) update.run(encode(row.label), row.profileId, row.confidence, row.id);
      changedRecordings++;
      renamed += renames.size;
    }
    this.refreshCounts();
    return { recordings: changedRecordings, renamed };
  }
}
