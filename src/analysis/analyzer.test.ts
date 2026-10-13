import { expect, test } from 'bun:test';
import { groundTasks } from './analyzer';

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
