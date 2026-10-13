import { Hono } from 'hono';
import { z } from 'zod';
import type { MeetingRecorder } from '../meetings/meeting-recorder';

const settingsInput = z.object({
  autoRecord: z.boolean().optional(),
  enabledApps: z.array(z.string().max(40)).max(40).optional(),
}).strict();

export function createMeetingsApi(recorder: MeetingRecorder) {
  const api = new Hono();
  const attempt = (run: () => unknown) => {
    try { return { success: true as const, data: run() }; }
    catch (error) { return { success: false as const, error: error instanceof Error ? error.message : String(error) }; }
  };

  api.get('/', c => c.json({ success: true, data: recorder.status() }));
  api.put('/settings', async c => {
    const parsed = settingsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ success: false, error: 'Invalid meeting settings.' }, 400);
    const result = attempt(() => recorder.configure(parsed.data));
    return c.json(result, result.success ? 200 : 409);
  });
  api.post('/start', c => {
    const result = attempt(() => recorder.startManually());
    return c.json(result, result.success ? 200 : 409);
  });
  api.post('/stop', c => c.json({ success: true, data: recorder.stop() }));
  api.post('/hold', async c => {
    const body = await c.req.json().catch(() => null) as { active?: unknown } | null;
    if (typeof body?.active !== 'boolean') return c.json({ success: false, error: 'Expected { active: boolean }.' }, 400);
    return c.json({ success: true, data: recorder.hold(body.active) });
  });
  return api;
}
