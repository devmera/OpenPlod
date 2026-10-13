/**
 * Plaud cloud summaries are templates its app completes when displaying them: `$[audio_start_time]`
 * variables, unfilled `[Insert Location]` lines, and speakers as `[Speaker 1]`. OpenPlod stores the
 * text as received and completes it on read, so later speaker renames show up too.
 */
import type { Database } from 'bun:sqlite';

const localDateTime = (iso: string) => new Date(iso).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Whether the text still has parts of Plaud's template to complete. */
export const isPlaudTemplate = (text: string) => text.includes('$[') || /\[(Speaker \d+|Insert [^\]]*)\]/.test(text);

export function completePlaudSummary(text: string, context: { recordedAt: string | null; speakerNames: Map<number, string> }): string {
  if (!isPlaudTemplate(text)) return text;
  return text
    .replace(/\$\[audio_start_time\]/g, context.recordedAt ? localDateTime(context.recordedAt) : 'unknown')
    .replace(/\$\[[a-z_]+\]/g, '')
    .split('\n').filter(line => !/^\s*(>\s*)?[^\n:]*:\s*\[Insert [^\]]*\]\s*$/.test(line)).join('\n')
    // Adjacent bracketed names form a list: "[A] [B]" reads "A, B".
    .replace(/\](\s+)\[(?=[^\]\n]{1,60}\])/g, '], [')
    // Plaud numbers speakers from 1; the library from 0.
    .replace(/\[Speaker (\d+)\]/g, (_, n: string) => context.speakerNames.get(Number(n) - 1) ?? `Speaker ${n}`)
    // Remaining single-bracket names in participant lists, e.g. "[Joakim] [Martin J]".
    .replace(/(^|\s)\[([^\]\n[]{1,60})\](?!\(|:)/g, '$1$2');
}

/**
 * Names given to Plaud's numbered speakers: the first generated version holds Plaud's numbers, the
 * current transcript the user's names, segment for segment.
 */
export function plaudSpeakerNames(sqlite: Database, recordingId: string): Map<number, string> {
  const names = new Map<number, string>();
  const generated = sqlite.query("SELECT segments FROM transcript_versions WHERE recording_id = ? AND origin = 'generated' ORDER BY created_at LIMIT 1").get(recordingId) as { segments: string | null } | null;
  const current = sqlite.query('SELECT segments FROM transcripts WHERE recording_id = ?').get(recordingId) as { segments: string | null } | null;
  try {
    const before = JSON.parse(generated?.segments ?? '[]') as { speaker?: unknown }[], after = JSON.parse(current?.segments ?? '[]') as { speaker?: unknown }[];
    if (before.length !== after.length) return names;
    before.forEach((segment, index) => {
      const named = after[index]?.speaker;
      if (typeof segment.speaker === 'number' && typeof named === 'string' && !names.has(segment.speaker)) names.set(segment.speaker, named);
    });
  } catch { /* Unreadable segments: keep Plaud's numbers. */ }
  return names;
}

/** The stored summary with Plaud's template parts completed, in whichever shape it was stored. */
export function presentSummary<T>(sqlite: Database, recordingId: string, recordedAt: string | null, summary: T): T {
  // Speaker names are looked up only for summaries that still carry Plaud's template.
  const complete = (text: string) => isPlaudTemplate(text) ? completePlaudSummary(text, { recordedAt, speakerNames: plaudSpeakerNames(sqlite, recordingId) }) : text;
  if (typeof summary === 'string') return complete(summary) as T;
  if (summary && typeof summary === 'object' && typeof (summary as { overview?: unknown }).overview === 'string')
    return { ...summary, overview: complete((summary as unknown as { overview: string }).overview) };
  return summary;
}
