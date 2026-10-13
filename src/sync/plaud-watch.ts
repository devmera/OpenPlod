import { readStoredIdentity } from './plaud-provision';
import { findRustBridge, usesSwiftBridge } from './plaud-bridge';
import type { PlaudAutoImport } from './plaud-auto-import';

/**
 * Background sync trigger. `plaud-bridge watch` listens for the recorder's
 * advertisements without connecting (free for the recorder's battery). The Note
 * Pro beacons every ~25 s whether or not anything changed, so a sighting only
 * says "in range": it starts a sync round at most once per `interval`, and
 * "Sync now" starts one at the next sighting regardless.
 */
export type WatchEvent = { event: 'ready' } | { event: 'seen'; serial: string; identifier: string; rssi: number | null } | { event: 'exit' };

export interface WatchProcess { stop(): void }

export const WATCH_INTERVAL_MS = 2 * 60_000;
/** Within a sync round, how long to wait before listing again to confirm recordings are complete. */
export const SETTLE_MS = 3000;
/** A recorder not seen for this long is reported as out of range. */
export const PRESENCE_MS = 90_000;

export class PlaudWatcher {
  private process: WatchProcess | null = null;
  private stopped = false;
  private lastSeen: { at: number; rssi: number | null } | null = null;
  private lastRound = 0;
  private syncRequested = false;
  private restarts = 0;

  constructor(private automatic: PlaudAutoImport, private options: {
    spawn?: (onEvent: (event: WatchEvent) => void) => WatchProcess | null;
    serial?: () => Promise<string | null>;
    now?: () => number;
    interval?: number;
  } = {}) {}

  private now() { return (this.options.now ?? Date.now)(); }

  /** Starts listening; false when this machine has no watch-capable bridge (the caller then polls). */
  start(): boolean {
    this.stopped = false;
    if (this.process) return true;
    this.process = (this.options.spawn ?? spawnWatch)(event => void this.onEvent(event));
    return Boolean(this.process);
  }

  stop() { this.stopped = true; this.process?.stop(); this.process = null; }

  active() { return Boolean(this.process); }

  /** "Sync now": sync immediately if the recorder is in range, else at its next sighting. */
  requestSync() {
    if (this.inRange()) { this.lastRound = this.now(); void this.automatic.tick({ settleMs: SETTLE_MS, force: true }); }
    else this.syncRequested = true;
    return this.status();
  }

  inRange() { return Boolean(this.lastSeen && this.now() - this.lastSeen.at < PRESENCE_MS); }

  status() {
    return {
      watching: Boolean(this.process),
      inRange: this.inRange(),
      lastSeenAt: this.lastSeen ? new Date(this.lastSeen.at).toISOString() : null,
      rssi: this.lastSeen?.rssi ?? null,
      syncPending: this.syncRequested,
    };
  }

  async onEvent(event: WatchEvent) {
    if (event.event === 'ready') { this.restarts = 0; return; }
    if (event.event === 'exit') {
      this.process = null;
      if (!this.stopped) setTimeout(() => { if (!this.stopped) this.start(); }, Math.min(300_000, 5000 * 2 ** Math.min(this.restarts++, 6))).unref?.();
      return;
    }
    const serial = await (this.options.serial ?? storedSerial)();
    if (!serial || event.serial !== serial) return;
    this.lastSeen = { at: this.now(), rssi: event.rssi };
    const due = this.now() - this.lastRound >= (this.options.interval ?? WATCH_INTERVAL_MS);
    if (!this.syncRequested && !due) return;
    const force = this.syncRequested;
    this.syncRequested = false;
    this.lastRound = this.now();
    await this.automatic.tick({ settleMs: SETTLE_MS, force });
  }
}

async function storedSerial() { return (await readStoredIdentity())?.serial ?? null; }

function spawnWatch(onEvent: (event: WatchEvent) => void): WatchProcess | null {
  const bridge = usesSwiftBridge() ? null : findRustBridge();
  if (!bridge) return null;
  const child = Bun.spawn([bridge, 'watch'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line) as WatchEvent); } catch { /* ignore malformed helper output */ }
      }
    }
  })().finally(() => { void child.exited.then(() => onEvent({ event: 'exit' })); });
  // Closing stdin ends the helper's listening loop.
  return { stop: () => { try { child.stdin.end(); } catch { /* already closed */ } } };
}
