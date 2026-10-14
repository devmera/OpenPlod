import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDeleteRequest, parseDeleteResponse } from './plaud-protocol';
import { deletePlaudSession, type PlaudPackets } from './plaud-transfer';
import { deviceOriginalPath, localCopyRefusal } from '../library/recorder-copies';

const replies = (packets: Buffer[], written: Buffer[] = []): PlaudPackets => ({
  async write(packet) { written.push(Buffer.from(packet)); },
  async packet() { const next = packets.shift(); if (!next) throw new Error('timeout'); return next; },
});

test('delete is opcode 30 with the session id, and its reply carries a status', () => {
  expect(buildDeleteRequest(0x66f0a1b2).toString('hex')).toBe('011e00b2a1f066');
  expect(parseDeleteResponse(Buffer.from('011e00b2a1f06600', 'hex'))).toEqual({ sessionId: 0x66f0a1b2, status: 0 });
  expect(parseDeleteResponse(Buffer.from('011e0003', 'hex'))).toEqual({ sessionId: null, status: 3 });
  expect(parseDeleteResponse(Buffer.from('011a00', 'hex'))).toBeNull();
});

test('waits for the reply to this session, refuses on a nonzero status, reports silence as unconfirmed', async () => {
  const written: Buffer[] = [];
  expect(await deletePlaudSession(replies([Buffer.from('011a0000', 'hex'), Buffer.from('011e000800000000', 'hex'), Buffer.from('011e000700000000', 'hex')], written), 7)).toEqual({ confirmed: true });
  expect(written).toEqual([Buffer.from('011e0007000000', 'hex')]);
  await expect(deletePlaudSession(replies([Buffer.from('011e000700000002', 'hex')]), 7)).rejects.toThrow('status 2');
  expect(await deletePlaudSession(replies([]), 7)).toEqual({ confirmed: false });
});

let directory = '';
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

test('a recording is deletable only when OpenPlod holds that exact file', () => {
  directory = mkdtempSync(join(tmpdir(), 'openplod-copies-'));
  const sqlite = new Database(':memory:');
  sqlite.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, source_provider TEXT, source_recording_id TEXT)");
  const audio = join(directory, 'r1.m4a');
  sqlite.query("INSERT INTO recordings VALUES ('r1', ?, 'plaud', 'SN1:7')").run(audio);
  const session = { sessionId: 7, size: 4 };
  expect(localCopyRefusal(sqlite, 'SN1', { sessionId: 8, size: 4 })).toContain('Not imported');
  expect(localCopyRefusal(sqlite, 'SN1', session)).toContain('missing');
  writeFileSync(audio, 'audio');
  expect(localCopyRefusal(sqlite, 'SN1', session)).toContain('no copy');
  mkdirSync(join(directory, 'originals', 'r1'), { recursive: true });
  writeFileSync(deviceOriginalPath(audio, 'r1'), 'abc');
  expect(localCopyRefusal(sqlite, 'SN1', session)).toContain('does not match');
  writeFileSync(deviceOriginalPath(audio, 'r1'), 'abcd');
  expect(localCopyRefusal(sqlite, 'SN1', session)).toBeNull();
  // Another recorder's session with the same id is a different recording.
  expect(localCopyRefusal(sqlite, 'SN2', session)).toContain('Not imported');
});
