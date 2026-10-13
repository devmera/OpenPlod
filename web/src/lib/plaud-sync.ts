import { useEffect, useState } from 'react'
import { api, type PlaudSyncStatus } from '@/lib/api'

/** Polls the background sync state (no Bluetooth: the server already tracks it). */
export function usePlaudSyncStatus(intervalMs = 4000) {
  const [status, setStatus] = useState<PlaudSyncStatus | null>(null)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await api.getPlaudSyncStatus(); if (!disposed) setStatus(next) } catch { /* keep the last known state */ }
      if (!disposed) timer = setTimeout(poll, document.hidden ? intervalMs * 4 : intervalMs)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [intervalMs])
  return status
}

/** "just now", "4 min ago", "2 h ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  return `${Math.floor(seconds / 86400)} days ago`
}

/** One line for the recorder's presence as background sync sees it. */
export function presenceLabel(status: PlaudSyncStatus | null): { label: string; live: boolean } | null {
  if (!status?.watch?.watching) return null
  if (status.running) return { label: 'Syncing…', live: true }
  if (status.watch.inRange) return { label: 'Nearby', live: true }
  if (status.watch.lastSeenAt) return { label: `Seen ${timeAgo(status.watch.lastSeenAt)}`, live: false }
  return { label: 'Not seen yet', live: false }
}
