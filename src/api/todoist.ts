import { Hono } from 'hono';
import { z } from 'zod';
import type { TodoistPublisher } from '../library/todoist';

const failure = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Todoist connection, and sending a recording's action items as tasks. The token is never returned. */
export function createTodoistApi(publisher: TodoistPublisher) {
  const app = new Hono();
  app.get('/', c => c.json({ success: true, data: { settings: publisher.settings(), lastRun: publisher.lastRun } }));
  app.put('/', async c => {
    const body = z.object({ token: z.string().trim().max(200).regex(/^[^\r\n]*$/).optional(), projectId: z.string().max(64), auto: z.boolean(), principal: z.string().max(120) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: 'Project, your name and automatic sending are required.' }, 400);
    try { return c.json({ success: true, data: await publisher.saveSettings(body.data) }); }
    catch (error) { return c.json({ success: false, error: failure(error, 'Todoist settings not saved.') }, 400); }
  });
  app.delete('/', c => c.json({ success: true, data: publisher.disconnect() }));
  app.get('/projects', async c => {
    try { return c.json({ success: true, data: await publisher.projects() }); }
    catch (error) { return c.json({ success: false, error: failure(error, 'Could not read Todoist projects.') }, 502); }
  });
  app.get('/tasks', async c => {
    await publisher.pullCompletion();
    return c.json({ success: true, data: { connected: publisher.settings().connected, meetings: publisher.allTasks() } });
  });
  /** `{ key, done }` ticks a task off or back on, in Todoist too when it was sent there. */
  app.post('/recordings/:id/done', async c => {
    const body = z.object({ key: z.string().max(64), done: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: 'Task and state are required.' }, 400);
    try { return c.json({ success: true, data: await publisher.setDone(c.req.param('id'), body.data.key, body.data.done) }); }
    catch (error) { return c.json({ success: false, error: failure(error, 'Could not update the task.') }, 502); }
  });
  app.get('/recordings/:id', async c => {
    await publisher.pullCompletion();
    return c.json({ success: true, data: { connected: publisher.settings().connected, tasks: publisher.tasks(c.req.param('id')) } });
  });
  /** `{ keys }` sends those action items; without keys, every one marked as yours. */
  app.post('/recordings/:id', async c => {
    const body = z.object({ keys: z.array(z.string().max(64)).max(50).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ success: false, error: 'Unsupported request.' }, 400);
    try { return c.json({ success: true, data: await publisher.send(c.req.param('id'), body.data.keys) }); }
    catch (error) { return c.json({ success: false, error: failure(error, 'Could not send to Todoist.') }, 502); }
  });
  return app;
}
