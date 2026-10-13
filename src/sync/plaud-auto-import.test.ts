import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PlaudAutoImport } from './plaud-auto-import';
test('automatic import requires opt-in and stable recordings, deduplicates and retains failures as unknown', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
    let calls = 0, imports = 0, fail = false;
    const automatic = new PlaudAutoImport(db, {
      configured: () => true,
      list: async () => { calls++; if (fail) throw new Error('Bluetooth disconnected'); return { serial: 'device', checkedAt: new Date().toISOString(), sessions: [{ sessionId: 7, size: 1000, scene: 0, timezone: 0 }] }; },
      import: async () => { imports++; db.query('INSERT INTO recordings VALUES(?,?,?)').run('saved-id', 'plaud', 'device:7'); return { added: true, durationMs: 1000, sourceRetained: true, recording: { id: 'saved-id', filePath: 'test', originalFilename: 'test', fingerprint: 'test', sourceRecordingId: 'device:7' } }; },
    });
    await automatic.tick(); expect(calls).toBe(0);
    automatic.set(true); await automatic.tick(); expect(imports).toBe(0); await automatic.tick(); expect(imports).toBe(1);
    await automatic.tick(); expect(imports).toBe(1); expect(automatic.status().events).toHaveLength(1);
    fail = true; await automatic.tick(); expect(automatic.status().error).toBe('Bluetooth disconnected');
    const previousCalls = calls; await automatic.tick(); expect(calls).toBe(previousCalls);
  } finally { db.close(); }
});

test('a recording made under another key is skipped once, without blocking newer ones', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
    const attempts: number[] = [];
    const automatic = new PlaudAutoImport(db, {
      configured: () => true,
      list: async () => ({ serial: 'device', checkedAt: new Date().toISOString(), sessions: [
        { sessionId: 1, size: 1000, scene: 0, timezone: 0 }, { sessionId: 2, size: 1000, scene: 0, timezone: 0 }] }),
      import: async (sessionId: number) => {
        attempts.push(sessionId);
        if (sessionId === 1) throw new Error('This recording was made while the recorder was bound to a key this computer does not hold, so it cannot be decrypted here.');
        db.query('INSERT INTO recordings VALUES(?,?,?)').run('new-id', 'plaud', 'device:2');
        return { added: true, durationMs: 1000, sourceRetained: true, recording: { id: 'new-id', filePath: 'test', originalFilename: 'test', fingerprint: 'test', sourceRecordingId: 'device:2' } };
      },
    });
    automatic.set(true); await automatic.tick(); await automatic.tick();
    expect(attempts).toEqual([1, 2]);
    expect(automatic.status().events).toHaveLength(1);
    expect(automatic.status()).toMatchObject({ error: null, skipped: 1 });
    await automatic.tick();
    expect(attempts).toEqual([1, 2]); // neither downloaded again
  } finally { db.close(); }
});

test('a settled listing imports a finished recording in the same round and reports the sync', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
    const listed: (number | undefined)[] = [];
    const imports: number[] = [];
    const automatic = new PlaudAutoImport(db, {
      configured: () => true,
      list: async (options?: { settleMs?: number }) => {
        listed.push(options?.settleMs);
        return { serial: 'device', checkedAt: '2026-10-13T12:00:00.000Z', stable: [4],
          sessions: [{ sessionId: 4, size: 2000, scene: 0, timezone: 0 }, { sessionId: 5, size: 900, scene: 0, timezone: 0 }] };
      },
      import: async (sessionId: number) => {
        imports.push(sessionId);
        db.query('INSERT INTO recordings VALUES(?,?,?)').run(`id-${sessionId}`, 'plaud', `device:${sessionId}`);
        return { added: true, durationMs: 1000, sourceRetained: true, recording: { id: `id-${sessionId}`, filePath: 'test', originalFilename: 'test', fingerprint: 'test', sourceRecordingId: `device:${sessionId}` } };
      },
    });
    automatic.set(true);
    await automatic.tick({ settleMs: 3000 });
    expect(listed).toEqual([3000]);
    expect(imports).toEqual([4]); // 5 was still growing during the settle pause
    expect(automatic.status().lastSync).toEqual({ at: '2026-10-13T12:00:00.000Z', imported: 1 });
  } finally { db.close(); }
});

test('the verdict survives a restart and is revisited when the held keys change', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE user_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recordings(id TEXT,source_provider TEXT,source_recording_id TEXT)');
    const attempts: number[] = [];
    let keys = 'old-keys';
    const adapter = {
      configured: () => true, keys: () => keys,
      list: async () => ({ serial: 'device', checkedAt: new Date().toISOString(), sessions: [{ sessionId: 1, size: 1000, scene: 0, timezone: 0 }] }),
      import: async (sessionId: number): Promise<never> => { attempts.push(sessionId); throw new Error('This recording was made while the recorder was bound to a key this computer does not hold, so it cannot be decrypted here.'); },
    };
    const first = new PlaudAutoImport(db, adapter);
    first.set(true); await first.tick(); await first.tick();
    expect(attempts).toEqual([1]);
    const restarted = new PlaudAutoImport(db, adapter);
    await restarted.tick(); await restarted.tick();
    expect(attempts).toEqual([1]);
    expect(restarted.status()).toMatchObject({ skipped: 1 });
    keys = 'imported-another-key';
    await restarted.tick();
    expect(attempts).toEqual([1, 1]);
  } finally { db.close(); }
});
