import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { TranscriptSegment, TranscriptWord } from './types';

const run = promisify(execFile);

/** The desktop app passes the vault database path; local models and tools live beside it. */
export function localDataDir() {
  return process.env.DATABASE_URL ? dirname(process.env.DATABASE_URL) : join(homedir(), '.openplod');
}

/** Python environment with pyannote.audio installed. The model is fetched once with the user's Hugging Face token. */
export const diarizationPython = () => process.env.OPENPLOD_DIARIZE_PYTHON || join(localDataDir(), 'diarization/.venv/bin/python');
export const diarizationAvailable = () => existsSync(diarizationPython());

export interface SpeakerTurn { start: number; end: number; speaker: number }

// Reads 16 kHz mono PCM itself, so pyannote never depends on a system audio decoder.
const script = `
import json, sys, wave
import numpy as np, torch
from pyannote.audio import Pipeline
with wave.open(sys.argv[1]) as f:
    rate = f.getframerate()
    samples = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")
if pipeline is None:
    sys.exit("pyannote model unavailable: accept its terms on Hugging Face and run 'hf auth login'")
if torch.backends.mps.is_available():
    pipeline.to(torch.device("mps"))
out = pipeline({"waveform": torch.from_numpy(samples).unsqueeze(0), "sample_rate": rate})
annotation = getattr(out, "exclusive_speaker_diarization", None) or getattr(out, "speaker_diarization", out)
turns = [{"start": t.start, "end": t.end, "speaker": s} for t, _, s in annotation.itertracks(yield_label=True)]
with open(sys.argv[2], "w") as f:
    json.dump(turns, f)
`;
const turnsSchema = z.array(z.object({ start: z.number(), end: z.number(), speaker: z.string() }));

/** Speaker turns for a 16 kHz mono WAV. Speakers are numbered from `first` in order of first appearance. */
export async function diarize(wav: string, directory: string, signal: AbortSignal, first = 0): Promise<SpeakerTurn[]> {
  const path = join(directory, 'diarize.py'), output = join(directory, 'turns.json');
  await writeFile(path, script, { mode: 0o600 });
  await run(diarizationPython(), [path, wav, output], { signal, timeout: 1800000, maxBuffer: 16 * 1024 * 1024 });
  const raw = turnsSchema.parse(JSON.parse(await readFile(output, 'utf8')));
  const ids = new Map<string, number>();
  return raw.sort((a, b) => a.start - b.start).map(turn => {
    if (!ids.has(turn.speaker)) ids.set(turn.speaker, first + ids.size);
    return { start: turn.start, end: turn.end, speaker: ids.get(turn.speaker)! };
  });
}

/** The turn overlapping the span most, or the nearest one when none overlaps. */
export function speakerAt(start: number, end: number, turns: SpeakerTurn[]): number | undefined {
  let best: SpeakerTurn | undefined, score = -Infinity;
  for (const turn of turns) {
    const overlap = Math.min(end, turn.end) - Math.max(start, turn.start);
    const value = overlap > 0 ? overlap : overlap - 1e6; // any overlap beats proximity
    if (value > score) { score = value; best = turn; }
  }
  return best?.speaker;
}

/** Label each word and split segments where the speaker changes. Segments without words keep one label. */
export function applySpeakers(segments: TranscriptSegment[], turns: SpeakerTurn[]): TranscriptSegment[] {
  if (!turns.length) return segments;
  return segments.flatMap(segment => {
    if (!segment.words?.length) return [{ ...segment, speaker: speakerAt(segment.start, segment.end, turns) }];
    const runs: { speaker: number | undefined; words: TranscriptWord[] }[] = [];
    for (const word of segment.words) {
      const speaker = speakerAt(word.start, word.end, turns);
      if (runs.at(-1)?.speaker === speaker) runs.at(-1)!.words.push(word);
      else runs.push({ speaker, words: [word] });
    }
    return runs.map(({ speaker, words }) => ({
      start: words[0].start, end: words.at(-1)!.end, speaker, confidence: segment.confidence, words,
      text: words.map(word => word.text).join(' '),
    }));
  });
}
