import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { SpeakerIdentity } from '../library/speaker-identity';

/** People recognised by voice across recordings, and this computer's user. */
export function createSpeakersApi(sqlite: Database) {
  const app = new Hono();
  const speakers = new SpeakerIdentity(sqlite);
  app.get('/', c => c.json({ success: true, data: { self: speakers.self(), people: speakers.people() } }));
  app.put('/self', async c => {
    const body = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: 'Enter your name (up to 80 characters).' }, 400);
    return c.json({ success: true, data: speakers.setSelfName(body.data.name) });
  });
  app.delete('/:id', c => { speakers.forget(c.req.param('id')); return c.json({ success: true, data: null }); });
  app.post('/reapply', c => c.json({ success: true, data: speakers.reapply() }));
  return app;
}
