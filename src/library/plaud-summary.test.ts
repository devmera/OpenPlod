import { expect, test } from 'bun:test';
import { completePlaudSummary } from './plaud-summary';

test('completes Plaud summary templates: date, unfilled lines, speaker names', () => {
  const text = `## Meeting Information
> Date: $[audio_start_time]
> Location: [Insert Location]
> Participants: [Speaker 1] [Joakim] [Speaker 3] [Martin J]
## Notes
- See [the plan](https://example.com) and [x]: kept.`;
  const done = completePlaudSummary(text, { recordedAt: '2026-10-13T11:05:10Z', speakerNames: new Map([[0, 'Thor']]) });
  expect(done).toContain(`> Date: ${new Date('2026-10-13T11:05:10Z').toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`);
  expect(done).not.toContain('Location');
  expect(done).toContain('> Participants: Thor, Joakim, Speaker 3, Martin J');
  expect(done).toContain('[the plan](https://example.com)');
  expect(completePlaudSummary('Plain summary.', { recordedAt: null, speakerNames: new Map() })).toBe('Plain summary.');
});
