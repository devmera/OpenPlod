/**
 * Recordings currently moving from the Plaud to this computer, for the library to show as rows
 * while they transfer. In memory only: a restart abandons transfers anyway, and finished ones
 * become ordinary recordings.
 */
export type PlaudTransferPhase = 'queued' | 'downloading' | 'decoding' | 'saving' | 'failed';
export interface PlaudTransfer {
  sessionId: number;
  /** Plaud session IDs are the recording's start time in Unix seconds. */
  recordedAt: string;
  size: number;
  received: number;
  phase: PlaudTransferPhase;
  error?: string;
  updatedAt: number;
}

const failedKeepMs = 5 * 60000;

export class PlaudTransfers {
  private items = new Map<number, PlaudTransfer>();
  private entry(sessionId: number, size: number): PlaudTransfer {
    return { sessionId, recordedAt: new Date(sessionId * 1000).toISOString(), size, received: 0, phase: 'queued', updatedAt: Date.now() };
  }
  /** Recordings a sync round is about to fetch, so the whole queue shows at once. */
  queue(sessions: { sessionId: number; size: number }[]) {
    for (const session of sessions) {
      const current = this.items.get(session.sessionId);
      if (!current || current.phase === 'failed') this.items.set(session.sessionId, this.entry(session.sessionId, session.size));
    }
  }
  update(sessionId: number, size: number, patch: Partial<Pick<PlaudTransfer, 'phase' | 'received'>>) {
    const current = this.items.get(sessionId) ?? this.entry(sessionId, size);
    this.items.set(sessionId, { ...current, size, error: undefined, ...patch, updatedAt: Date.now() });
  }
  finish(sessionId: number) { this.items.delete(sessionId); }
  fail(sessionId: number, error: string) {
    const current = this.items.get(sessionId);
    if (current) this.items.set(sessionId, { ...current, phase: 'failed', error, updatedAt: Date.now() });
  }
  /** Queued entries a round did not reach (cancelled, disconnected, or no longer eligible). */
  dropQueued() { for (const [id, item] of this.items) if (item.phase === 'queued') this.items.delete(id); }
  list(now = Date.now()): PlaudTransfer[] {
    for (const [id, item] of this.items) if (item.phase === 'failed' && now - item.updatedAt > failedKeepMs) this.items.delete(id);
    return [...this.items.values()].sort((a, b) => b.sessionId - a.sessionId);
  }
}

export const plaudTransfers = new PlaudTransfers();
