import { expect, test } from 'bun:test';
import { PlaudWatcher, PRESENCE_MS, SETTLE_MS, WATCH_INTERVAL_MS, type WatchEvent } from './plaud-watch';
import type { PlaudAutoImport } from './plaud-auto-import';

function setup(serial: string | null = '8810B30290242073') {
  let clock = 1_000_000;
  const ticks: { settleMs?: number; force?: boolean }[] = [];
  let emit: (event: WatchEvent) => void = () => {};
  let spawns = 0;
  const automatic = { tick: async (options: { settleMs?: number; force?: boolean } = {}) => { ticks.push(options); } } as unknown as PlaudAutoImport;
  const watcher = new PlaudWatcher(automatic, {
    spawn: onEvent => { spawns++; emit = onEvent; return { stop: () => undefined }; },
    serial: async () => serial,
    now: () => clock,
  });
  const beacon = (from = '8810B30290242073') => watcher.onEvent({ event: 'seen', serial: from, identifier: 'D022B899-BADE-7EE5-0E6B-13BCFB747377', rssi: -70 });
  return { watcher, ticks, beacon, advance: (ms: number) => { clock += ms; }, emit: (event: WatchEvent) => emit(event), spawns: () => spawns };
}

test('a beacon starts a settled sync round at most once per interval', async () => {
  const { watcher, ticks, beacon, advance } = setup();
  expect(watcher.start()).toBe(true);
  await beacon();
  expect(ticks).toEqual([{ settleMs: SETTLE_MS, force: false }]);
  for (let elapsed = 0; elapsed < WATCH_INTERVAL_MS - 25_000; elapsed += 25_000) { advance(25_000); await beacon(); }
  expect(ticks).toHaveLength(1); // the recorder's idle beacons do not cost a connection each
  advance(25_000); await beacon();
  expect(ticks).toHaveLength(2);
  expect(watcher.status()).toMatchObject({ watching: true, inRange: true, rssi: -70 });
});

test('only the authorized recorder counts', async () => {
  const { ticks, beacon, watcher } = setup();
  await beacon('8810000000000000');
  expect(ticks).toEqual([]);
  expect(watcher.status().lastSeenAt).toBeNull();
  const unauthorized = setup(null);
  await unauthorized.beacon();
  expect(unauthorized.ticks).toEqual([]);
});

test('sync now runs at once in range, otherwise at the next beacon, ignoring the interval', async () => {
  const { watcher, ticks, beacon, advance } = setup();
  await beacon();
  watcher.requestSync();
  expect(ticks).toEqual([{ settleMs: SETTLE_MS, force: false }, { settleMs: SETTLE_MS, force: true }]);
  advance(PRESENCE_MS);
  expect(watcher.status().inRange).toBe(false);
  expect(watcher.requestSync().syncPending).toBe(true);
  expect(ticks).toHaveLength(2);
  advance(1000); await beacon();
  expect(ticks.at(-1)).toEqual({ settleMs: SETTLE_MS, force: true });
  expect(watcher.status().syncPending).toBe(false);
});

test('restarts the listener after it exits, and not after stop', async () => {
  const { watcher, emit, spawns } = setup();
  watcher.start();
  emit({ event: 'exit' });
  expect(watcher.active()).toBe(false);
  await Bun.sleep(5100);
  expect(spawns()).toBe(2);
  watcher.stop();
  emit({ event: 'exit' });
  await Bun.sleep(5100);
  expect(spawns()).toBe(2);
}, 15000);
