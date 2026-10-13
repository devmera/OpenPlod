import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { TranscriptionEngine, TranscriptionOptions, TranscriptionResult, TranscriptSegment, TranscriptWord } from './types';
import { transcriptionFailure } from './openai';
import { applySpeakers, diarizationAvailable, diarize, dominantSpeaker, localDataDir } from './diarization';

const run = promisify(execFile);
const binary = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const vadBinary = join(dirname(binary), 'whisper-vad-speech-segments');
const models = process.env.WHISPER_MODELS_DIR || join(localDataDir(), 'models/whisper');
/** Supported multilingual models and the alignment-head preset whisper.cpp uses for their word timings. */
const dtwPresets: Record<string, string> = { base: 'base', small: 'small', medium: 'medium', 'large-v3-turbo': 'large.v3.turbo', 'kb-whisper-large': 'large.v3' };
const tokenSchema = z.object({ text: z.string(), offsets: z.object({ from: z.number(), to: z.number() }), t_dtw: z.number().optional() });
const resultSchema = z.object({
  result: z.object({ language: z.string() }).partial().optional(),
  transcription: z.array(z.object({ text: z.string(), offsets: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative() }), tokens: z.array(tokenSchema).optional() })),
});
type Stage = 'converting' | 'transcribing' | 'diarizing';
type Span = { start: number; end: number };
const vadModel = () => join(models, 'ggml-silero-v5.1.2.bin');

/** Drop words, then segments, that Silero VAD heard no speech under: Whisper invents text ("Thank you.") over silence. */
export function keepSpeech(segments: TranscriptSegment[], speech: Span[], pad = 0.3): TranscriptSegment[] {
  const heard = (start: number, end: number) => speech.some(span => Math.min(end, span.end + pad) > Math.max(start, span.start - pad));
  return segments.flatMap(segment => {
    if (!segment.words?.length) return heard(segment.start, segment.end) ? [segment] : [];
    const words = segment.words.filter(word => heard(word.start, word.end));
    if (words.length === segment.words.length) return [segment];
    return words.length ? [{ ...segment, start: words[0].start, end: words.at(-1)!.end, text: words.map(word => word.text).join(' '), words }] : [];
  });
}

/** Group sub-word tokens into words. DTW times are centiseconds; -1 means unavailable. */
export function wordsOf(tokens: z.infer<typeof tokenSchema>[], start: number, end: number): TranscriptWord[] | undefined {
  const words: TranscriptWord[] = [];
  for (const token of tokens) {
    if (/^\[_.*\]$|^<\|.*\|>$/.test(token.text)) continue;
    if (words.length && !token.text.startsWith(' ')) { words.at(-1)!.text += token.text; continue; }
    const at = (token.t_dtw ?? -1) >= 0 ? token.t_dtw! / 100 : token.offsets.from / 1000;
    words.push({ start: Math.min(end, Math.max(start, words.at(-1)?.start ?? start, at)), end, text: token.text.trim() });
  }
  const kept = words.filter(word => word.text);
  kept.forEach((word, index) => { word.end = kept[index + 1]?.start ?? end; });
  return kept.length ? kept : undefined;
}

export class WhisperEngine implements TranscriptionEngine {
  readonly name = 'whisper.cpp';
  isAvailable() { return existsSync(binary); }

  /** Speech regions in seconds, or null when the VAD tool or model is not installed. */
  private async speech(wav: string, signal: AbortSignal): Promise<Span[] | null> {
    if (!existsSync(vadBinary) || !existsSync(vadModel())) return null;
    const { stdout } = await run(vadBinary, ['-vm', vadModel(), '-f', wav], { signal, timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
    return [...stdout.matchAll(/start = ([\d.]+), end = ([\d.]+)/g)].map(match => ({ start: Number(match[1]) / 100, end: Number(match[2]) / 100 }));
  }

  private async transcribeWav(wav: string, output: string, modelPath: string, model: string, options: TranscriptionOptions, signal: AbortSignal) {
    // Word timings come from DTW, which whisper.cpp only computes with flash attention off.
    await run(binary, ['-m', modelPath, '-f', wav, '-t', String(Math.max(1, Math.min(16, options.threads || 4))), '-ojf', '-of', output, '--no-prints', '-l', options.language || 'auto', '-sns', '-dtw', dtwPresets[model], '-nfa'], { signal, timeout: 3600000 });
    const parsed = resultSchema.parse(JSON.parse(await readFile(`${output}.json`, 'utf8')));
    if (parsed.transcription.some(item => item.offsets.to < item.offsets.from)) throw new Error('Invalid offsets');
    const segments: TranscriptSegment[] = parsed.transcription.map(item => {
      const start = item.offsets.from / 1000, end = item.offsets.to / 1000;
      return { start, end, text: item.text.trim(), confidence: null, words: wordsOf(item.tokens ?? [], start, end) };
    }).filter(segment => segment.text);
    return { segments, language: parsed.result?.language ?? null };
  }

  async transcribeFile(path: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    if (!this.isAvailable()) return transcriptionFailure(this.name, 'Install whisper-cpp before local transcription.');
    const model = options.model || 'base';
    if (!dtwPresets[model]) return transcriptionFailure(this.name, 'Select a supported multilingual Whisper model.');
    const modelPath = join(models, `ggml-${model}.bin`);
    if (!existsSync(modelPath)) return transcriptionFailure(this.name, `Install ggml-${model}.bin in ${models} before transcription. No model or audio was downloaded.`);
    if (options.diarize && !diarizationAvailable()) return transcriptionFailure(this.name, `Speaker labels need a pyannote.audio environment in ${join(localDataDir(), 'diarization/.venv')}.`);
    const directory = await mkdtemp(join(tmpdir(), 'openplod-whisper-'));
    const signal = AbortSignal.any([AbortSignal.timeout(7200000), ...(options.signal ? [options.signal] : [])]);
    let stage: Stage = 'converting';
    try {
      options.onCheckpoint?.({ phase: stage });
      const wav = join(directory, 'audio.wav'), left = join(directory, 'left.wav'), right = join(directory, 'right.wav');
      const pcm = ['-ar', '16000', '-c:a', 'pcm_s16le'];
      // Meeting captures keep each side on its own channel, which labels this Mac's user exactly. Mono input falls back to one track.
      let split = false;
      if (options.channelSpeakers) {
        try {
          await run('ffmpeg', ['-y', '-i', path, '-filter_complex', '[0:a]pan=mono|c0=c0[l];[0:a]pan=mono|c0=c1[r]', '-map', '[l]', ...pcm, left, '-map', '[r]', ...pcm, right], { signal, timeout: 300000 });
          split = true;
        } catch { signal.throwIfAborted(); }
      }
      if (!split) {
        try { await run('ffmpeg', ['-y', '-i', path, '-ac', '1', ...pcm, wav], { signal, timeout: 300000 }); }
        catch { signal.throwIfAborted(); await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path, wav], { signal, timeout: 300000 }); }
      }
      // fixed: the whole track is one known speaker; first: diarized speakers are numbered from here.
      const tracks = split
        ? [{ wav: left, fixed: 0, first: 0 }, { wav: right, fixed: options.diarize ? undefined : 1, first: 1 }]
        : [{ wav, fixed: undefined, first: 0 }];
      const segments: TranscriptSegment[] = [];
      let language: string | null = null;
      const embeddings: Record<number, number[]> = {};
      for (const [index, track] of tracks.entries()) {
        stage = 'transcribing';
        options.onCheckpoint?.({ phase: stage });
        const speech = await this.speech(track.wav, signal);
        if (speech?.length === 0) continue;
        const result = await this.transcribeWav(track.wav, join(directory, `transcript-${index}`), modelPath, model, options, signal);
        if (speech) result.segments = keepSpeech(result.segments, speech);
        language ??= result.language;
        if (!options.diarize || !result.segments.length) {
          segments.push(...result.segments.map(segment => track.fixed === undefined ? segment : { ...segment, speaker: track.fixed }));
          continue;
        }
        stage = 'diarizing';
        options.onCheckpoint?.({ phase: stage });
        const found = await diarize(track.wav, directory, signal, track.first);
        if (track.fixed === undefined) {
          segments.push(...applySpeakers(result.segments, found.turns));
          Object.assign(embeddings, found.embeddings);
        } else {
          // The microphone channel is one known person; its main voice still teaches that person's voiceprint.
          segments.push(...result.segments.map(segment => ({ ...segment, speaker: track.fixed })));
          const main = dominantSpeaker(found.turns);
          if (main !== undefined && found.embeddings[main]) embeddings[track.fixed] = found.embeddings[main];
        }
      }
      signal.throwIfAborted();
      segments.sort((a, b) => a.start - b.start);
      const speakers = new Set(segments.map(segment => segment.speaker).filter(speaker => speaker !== undefined));
      const fullText = segments.map(s => s.text).join(' ').trim();
      return { success: true, engine: this.name, fullText, segments, wordCount: fullText.split(/\s+/).filter(Boolean).length, speakerCount: speakers.size || null, confidence: null, duration: Math.max(0, ...segments.map(s => s.end)), metadata: { model, usage: null, language, ...(Object.keys(embeddings).length ? { speakerEmbeddings: embeddings } : {}), ...(split ? { selfSpeaker: 0 } : {}) } };
    } catch (error) {
      if (signal.aborted) return transcriptionFailure(this.name, 'Local transcription cancelled or timed out.');
      if (stage === 'diarizing') {
        const detail = String((error as { stderr?: string }).stderr || '').trim().split('\n').at(-1);
        return transcriptionFailure(this.name, `Speaker labelling failed${detail ? `: ${detail}` : '.'}`);
      }
      return transcriptionFailure(this.name, 'Local transcription failed. Check the Whisper model and audio converter installation.');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async transcribeBuffer(buffer: Buffer, _mimetype: string, options?: TranscriptionOptions) {
    const directory = await mkdtemp(join(tmpdir(), 'openplod-whisper-input-'));
    try { const path = join(directory, 'audio'); await writeFile(path, buffer, { mode: 0o600 }); return await this.transcribeFile(path, options); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
