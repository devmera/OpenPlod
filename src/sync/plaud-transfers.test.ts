import { expect, test } from 'bun:test';
import { PlaudTransfers } from './plaud-transfers';

test('queued recordings become progress, then disappear when saved', () => {
  const transfers = new PlaudTransfers();
  transfers.queue([{ sessionId: 1791898280, size: 4000 }, { sessionId: 1791898201, size: 2000 }]);
  expect(transfers.list().map(item => [item.sessionId, item.phase])).toEqual([[1791898280, 'queued'], [1791898201, 'queued']]);
  expect(transfers.list()[0].recordedAt).toBe(new Date(1791898280 * 1000).toISOString());
  transfers.update(1791898201, 2000, { phase: 'downloading', received: 500 });
  expect(transfers.list()[1]).toMatchObject({ phase: 'downloading', received: 500, size: 2000 });
  transfers.finish(1791898201);
  transfers.dropQueued();
  expect(transfers.list()).toEqual([]);
});

test('failures stay visible for a while, then clear; a new round retries them', () => {
  const transfers = new PlaudTransfers();
  transfers.update(5, 100, { phase: 'downloading', received: 10 });
  transfers.fail(5, 'Recorder disconnected');
  transfers.dropQueued();
  expect(transfers.list()[0]).toMatchObject({ phase: 'failed', error: 'Recorder disconnected' });
  transfers.queue([{ sessionId: 5, size: 100 }]);
  expect(transfers.list()[0]).toMatchObject({ phase: 'queued', received: 0 });
  transfers.fail(5, 'again');
  expect(transfers.list(Date.now() + 6 * 60000)).toEqual([]);
});
