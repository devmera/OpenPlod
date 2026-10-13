import { useCallback, useEffect, useState } from 'react'
import { api, type MeetingStatus } from '@/lib/api'
import { getRuntime } from '@/lib/runtime'

/** Meeting recording runs inside the desktop vault; phones and browsers never poll it. */
export const meetingsSupported = () => getRuntime().mode === 'desktop'

/**
 * Polls the meeting recorder. Faster while a recording is starting or running so
 * the timer and the stop button stay honest; slower when the window is hidden.
 */
export function useMeetingStatus(enabled = meetingsSupported()) {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await api.getMeetings(AbortSignal.timeout(5000))
      setStatus(next)
      setError('')
      return next
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The meeting recorder is unavailable.')
      return null
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const next = await refresh()
      if (disposed) return
      timer = setTimeout(poll, document.hidden ? 10000 : next?.recording ? 1500 : 4000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [enabled, refresh])

  return { status, setStatus, error, refresh }
}

/** Seconds since `startedAt`, ticking once a second. */
export function useElapsed(startedAt: string | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt ? Math.max(0, (now - Date.parse(startedAt)) / 1000) : 0
}
