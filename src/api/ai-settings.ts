import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { aiSettingsInput, readAiConfig, credential, secretNames, assertPrivacy, textProviders } from '../ai/config';
import { speechCapabilities, validateSpeechOptions } from '../ai/capabilities';
import { installedOllamaModels } from '../ai/text';

type KeyedProvider = 'mistral' | 'openai' | 'anthropic' | 'deepgram' | 'assemblyai';
const labels: Record<KeyedProvider, string> = { mistral: 'Mistral', openai: 'OpenAI', anthropic: 'Anthropic', deepgram: 'Deepgram', assemblyai: 'AssemblyAI' };

/** Asks the provider whether it accepts `key`, with a read-only request that costs nothing. */
export async function verifyKey(provider: KeyedProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  const urls = { mistral: 'https://api.mistral.ai/v1/models', openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models', deepgram: 'https://api.deepgram.com/v1/projects', assemblyai: 'https://api.assemblyai.com/v2/transcript?limit=1' };
  const headers: Record<string, string> = provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: provider === 'assemblyai' ? key : `${provider === 'deepgram' ? 'Token' : 'Bearer'} ${key}` };
  let response: Response;
  try { response = await fetchImpl(urls[provider], { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { return { ok: false, error: `${labels[provider]} could not be reached to check the key.` }; }
  await response.body?.cancel();
  if (response.ok) return { ok: true };
  return { ok: false, error: response.status === 401 || response.status === 403 ? `${labels[provider]} rejected the API key.` : `${labels[provider]} returned HTTP ${response.status}.` };
}

export function createAiSettingsApi(database: Database, fetchImpl: typeof fetch = fetch) {
  const app = new Hono();
  app.get('/', c => c.json({ success: true, data: { ...readAiConfig(database), credentials: Object.fromEntries(secretNames.map(key => [key, Boolean(credential(database, key.replace('ApiKey', '')))])), capabilities: speechCapabilities } }));
  app.put('/', async c => {
    const input = aiSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ success: false, error: 'Invalid AI settings.' }, 400);
    const { credentials, ...config } = input.data;
    try {
      assertPrivacy(config, config.transcriptionEngine);
      for (const provider of config.transcriptionFallback) assertPrivacy(config, provider);
      for (const task of ['analysis', 'document', 'chat'] as const) assertPrivacy(config, config[`${task}Provider`]);
      validateSpeechOptions(config.transcriptionEngine, { model: config.transcriptionModel, diarize: config.transcriptionDiarize, vocabulary: config.transcriptionVocabulary });
    } catch (error) { return c.json({ success: false, error: (error as Error).message }, 400); }
    // A new key is stored only after the provider accepts it.
    for (const [name, value] of Object.entries(credentials || {})) {
      if (typeof value !== 'string' || !value) continue;
      const result = await verifyKey(name.replace('ApiKey', '') as KeyedProvider, value, fetchImpl);
      if (!result.ok) return c.json({ success: false, error: `${result.error} Nothing was saved.` }, 400);
    }
    database.transaction(() => {
      const put = database.query("INSERT INTO user_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')");
      put.run('aiConfig', JSON.stringify(config)); put.run('transcriptionEngine', config.transcriptionEngine);
      for (const [key, value] of Object.entries(credentials || {})) if (typeof value === 'string') put.run(key, value);
    })();
    return c.json({ success: true });
  });
  app.get('/ollama-models', async c => {
    try { return c.json({ success: true, data: await installedOllamaModels() }); }
    catch { return c.json({ success: false, error: 'Local Ollama is unavailable. Start Ollama on this computer.' }, 503); }
  });
  app.post('/check/:provider', async c => {
    const provider = z.enum([...textProviders, 'deepgram', 'assemblyai']).safeParse(c.req.param('provider'));
    if (!provider.success) return c.json({ success: false, error: 'Unknown provider.' }, 400);
    try {
      assertPrivacy(readAiConfig(database), provider.data);
      if (provider.data === 'ollama') return c.json({ success: true, data: { reachable: true, models: await installedOllamaModels() } });
      // A key typed but not saved yet is checked as typed; otherwise the saved key.
      const typed = z.object({ key: z.string().trim().min(1).max(512) }).safeParse(await c.req.json().catch(() => null));
      const key = typed.success ? typed.data.key : credential(database, provider.data);
      if (!key) return c.json({ success: false, error: 'Enter an API key to check.' }, 400);
      const result = await verifyKey(provider.data, key, fetchImpl);
      return c.json({ success: result.ok, data: { reachable: result.ok }, ...(result.error ? { error: result.error } : {}) }, result.ok ? 200 : 400);
    } catch { return c.json({ success: false, error: 'Blocked by local-only mode.' }, 503); }
  });
  return app;
}
