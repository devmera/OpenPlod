import { expect, test } from 'bun:test';
import { applySpeakers, speakerAt } from './diarization';
import { keepSpeech, wordsOf } from './whisper';

const token = (text: string, from: number, t_dtw = -1) => ({ text, offsets: { from, to: from }, t_dtw });

test('groups sub-word tokens into words, preferring DTW times', () => {
  const words = wordsOf([token('[_BEG_]', 0), token(' Ja', 0, 176), token(',', 480, 192), token(' test', 1430, 232), token('ar', 1600, 250)], 1, 4);
  expect(words).toEqual([{ start: 1.76, end: 2.32, text: 'Ja,' }, { start: 2.32, end: 4, text: 'testar' }]);
});

test('keeps word starts inside the segment and in order', () => {
  expect(wordsOf([token(' a', 9000), token(' b', 100)], 2, 5)?.map(word => word.start)).toEqual([5, 5]);
  expect(wordsOf([token('[_BEG_]', 0)], 0, 1)).toBeUndefined();
});

test('picks the most-overlapping turn, else the nearest', () => {
  const turns = [{ start: 0, end: 2, speaker: 0 }, { start: 2, end: 5, speaker: 1 }, { start: 8, end: 9, speaker: 0 }];
  expect(speakerAt(1.5, 3, turns)).toBe(1);
  expect(speakerAt(6, 6.5, turns)).toBe(1);
  expect(speakerAt(7.5, 7.8, turns)).toBe(0);
});

test('splits a segment where the speaker changes', () => {
  const words = [{ start: 0, end: 1, text: 'Hej' }, { start: 1, end: 2, text: 'där.' }, { start: 2.2, end: 3, text: 'Hi' }, { start: 3, end: 4, text: 'there.' }];
  const result = applySpeakers([{ start: 0, end: 4, text: 'Hej där. Hi there.', confidence: null, words }], [{ start: 0, end: 2, speaker: 0 }, { start: 2, end: 4, speaker: 1 }]);
  expect(result.map(({ start, end, text, speaker }) => ({ start, end, text, speaker }))).toEqual([
    { start: 0, end: 2, text: 'Hej där.', speaker: 0 },
    { start: 2.2, end: 4, text: 'Hi there.', speaker: 1 },
  ]);
});

test('labels word-less segments whole and leaves segments alone without turns', () => {
  const segment = { start: 0, end: 1, text: 'x', confidence: null };
  expect(applySpeakers([segment], [{ start: 0, end: 1, speaker: 3 }])[0].speaker).toBe(3);
  expect(applySpeakers([segment], [])).toEqual([segment]);
});

test('drops words and segments outside detected speech', () => {
  const words = [{ start: 0, end: 1, text: 'Hej.' }, { start: 5, end: 6, text: 'Tack.' }];
  const segments = [{ start: 0, end: 6, text: 'Hej. Tack.', confidence: null, words }, { start: 10, end: 30, text: 'Thank you.', confidence: null }];
  expect(keepSpeech(segments, [{ start: 0.2, end: 1.1 }])).toEqual([{ start: 0, end: 1, text: 'Hej.', confidence: null, words: [words[0]] }]);
  expect(keepSpeech(segments, [])).toEqual([]);
});
