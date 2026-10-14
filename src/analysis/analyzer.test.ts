import { expect, test } from 'bun:test';
import { groundTasks, parseAnalysis, resolveDue, speakerTranscript } from './analyzer';

const transcript = 'We need a firewall change. Anna will open the SR for the new rules by Friday. Then security approves it.';

test('exact quotes are kept, loose ones point at the real passage, invented ones are dropped', () => {
  const tasks = groundTasks([
    { title: 'Firewall', context: 'We need a firewall change.' },
    { title: 'Open SR', context: 'anna will open the SR for the new rules, by friday' },
    { title: 'Invented', context: 'Bo books the conference room for next quarter.' },
  ], transcript);
  expect(tasks).toEqual([
    { title: 'Firewall', context: 'We need a firewall change.' },
    { title: 'Open SR', context: 'Anna will open the SR for the new rules by Friday.' },
  ]);
  for (const task of tasks) expect(transcript).toContain(task.context);
});

test('a quote spanning two sentences matches both', () => {
  expect(groundTasks([{ title: 'x', context: 'open the SR for the new rules by Friday then security approves it' }], transcript)[0].context)
    .toBe('Anna will open the SR for the new rules by Friday. Then security approves it.');
});

test('deadlines are counted from the recording day, never guessed', () => {
  const tuesday = new Date(2026, 9, 13, 15, 30);
  expect(resolveDue({ kind: 'relative_day', offset: 1, time: '14:00' }, tuesday)).toBe('2026-10-14T14:00');
  expect(resolveDue({ kind: 'relative_week', offset: 1 }, tuesday)).toBe('2026-10-20');
  expect(resolveDue({ kind: 'weekday', weekday: 'Friday' }, tuesday)).toBe('2026-10-16');
  // Said on a Tuesday, "on Tuesday" is that day, not next week.
  expect(resolveDue({ kind: 'weekday', weekday: 'tuesday' }, tuesday)).toBe('2026-10-13');
  expect(resolveDue({ kind: 'weekday', weekday: 'monday' }, tuesday)).toBe('2026-10-19');
  expect(resolveDue({ kind: 'absolute_date', date: '2026-11-03' }, tuesday)).toBe('2026-11-03');
  expect(resolveDue({ kind: 'absolute_date', date: '2026-02-30' }, tuesday)).toBeUndefined();
  expect(resolveDue({ kind: 'relative_day' }, tuesday)).toBeUndefined();
  expect(resolveDue(null, tuesday)).toBeUndefined();
});

test('the model sees speaker turns, with anonymous voices marked as unidentified', () => {
  expect(speakerTranscript([{ text: 'Hej.', speaker: 'Joakim' }, { text: 'Jag fixar det.', speaker: 'Joakim' }, { text: 'Bra.', speaker: 1 }], 'x'))
    .toBe('Joakim: Hej. Jag fixar det.\nSpeaker 2 (unidentified): Bra.');
  expect(speakerTranscript([{ text: 'No labels.' }], 'No labels.')).toBe('No labels.');
});

test('a fenced reply with stray fields and one unreadable task still yields the summary and the good tasks', () => {
  const reply = 'Here is the analysis:\n```json\n' + JSON.stringify({
    summary: { overview: 'Migration plan.', keyPoints: ['Envoy'], decisions: ['extra field'], participants: 'Thor' },
    extractedTasks: [
      { title: 'Set up Envoy', owner: 'Joakim', priority: 'urgent', due: { kind: 'someday' }, context: 'I will set up Envoy.' },
      { title: 'No quote' },
    ],
  }) + '\n```';
  const parsed = parseAnalysis(reply);
  expect(parsed.summary).toEqual({ overview: 'Migration plan.', keyPoints: ['Envoy'], participants: undefined, topics: undefined });
  expect(parsed.extractedTasks).toEqual([{ title: 'Set up Envoy', owner: 'Joakim', priority: null, due: null, context: 'I will set up Envoy.' }]);
  expect(() => parseAnalysis('Sorry, I cannot help.')).toThrow('not valid JSON');
  expect(() => parseAnalysis('{"summary":{}}')).toThrow('without a summary overview');
});
