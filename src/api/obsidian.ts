import { Hono } from 'hono';
import { z } from 'zod';
import type { ObsidianExporter } from '../library/obsidian-export';

/** Settings, status and manual export for the managed Obsidian notes. */
export function createObsidianApi(exporter: ObsidianExporter) {
  const app = new Hono();
  app.get('/', async c => c.json({ success: true, data: {
    settings: exporter.settings(), vaults: await exporter.discoverVaults(), conflicts: exporter.conflicts(), lastRun: exporter.lastRun, pending: exporter.pending().length,
  } }));
  app.put('/', async c => {
    const body = z.object({ vaultPath: z.string().max(1024), folder: z.string().max(256), auto: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ success: false, error: 'Vault, folder and automatic export are required.' }, 400);
    try { return c.json({ success: true, data: exporter.saveSettings(body.data) }); }
    catch (error) { return c.json({ success: false, error: error instanceof Error ? error.message : 'Settings not saved.' }, 400); }
  });
  /** `{ recordingId, replace? }` exports one note; `{ all: true }` exports every transcribed recording. */
  app.post('/export', async c => {
    const body = z.object({ recordingId: z.string().optional(), replace: z.boolean().optional(), all: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ success: false, error: 'Unsupported export request.' }, 400);
    try {
      const results = body.data.recordingId
        ? [await exporter.exportRecording(body.data.recordingId, { replace: body.data.replace })]
        : await exporter.run({ all: body.data.all });
      return c.json({ success: true, data: results });
    } catch (error) { return c.json({ success: false, error: error instanceof Error ? error.message : 'Export failed.' }, 400); }
  });
  return app;
}
