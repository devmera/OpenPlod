import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAiSettingsApi } from './ai-settings';

const setup = () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE user_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)['x-api-key'];
    seen.push(key);
    return new Response('{}', { status: key === 'good' ? 200 : 401 });
  }) as unknown as typeof fetch;
  return { sqlite, seen, app: createAiSettingsApi(sqlite, fetchImpl) };
};
const config = { analysisProvider: 'anthropic' };
const stored = (sqlite: Database) => (sqlite.query("SELECT value FROM user_settings WHERE key = 'anthropicApiKey'").get() as { value: string } | null)?.value;
const send = (app: ReturnType<typeof setup>['app'], path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('a typed key is checked before it is saved, and a rejected key is never stored', async () => {
  const { app, sqlite, seen } = setup();
  const typed = await send(app, '/check/anthropic', 'POST', { key: 'bad' });
  expect(typed.status).toBe(400);
  expect((await typed.json()).error).toBe('Anthropic rejected the API key.');
  const rejected = await send(app, '/', 'PUT', { ...config, credentials: { anthropicApiKey: 'bad' } });
  expect((await rejected.json()).error).toContain('Nothing was saved');
  expect(stored(sqlite)).toBeUndefined();
  expect((await send(app, '/', 'PUT', { ...config, credentials: { anthropicApiKey: 'good' } })).status).toBe(200);
  expect(stored(sqlite)).toBe('good');
  // Without a typed key, Check uses the saved one.
  expect((await send(app, '/check/anthropic', 'POST')).status).toBe(200);
  expect(seen).toEqual(['bad', 'bad', 'good', 'good']);
});
